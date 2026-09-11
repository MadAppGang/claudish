#!/usr/bin/env bun

// Load .env file before anything else (quiet mode to suppress verbose output)
import { config } from "dotenv";
config({ quiet: true }); // Loads .env from current working directory

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Load API keys and custom endpoints from ~/.claudish/config.json into process.env.
 * Environment variables already set take precedence over stored values.
 * Uses raw fs reads (no profile-config.ts import) to avoid loading heavy dependencies
 * on every CLI invocation.
 */
function loadStoredApiKeys(): void {
  try {
    const configPath = join(homedir(), ".claudish", "config.json");
    if (!existsSync(configPath)) return;
    const raw = readFileSync(configPath, "utf-8");
    const cfg = JSON.parse(raw) as {
      apiKeys?: Record<string, string>;
      endpoints?: Record<string, string>;
    };
    if (cfg.apiKeys) {
      for (const [envVar, value] of Object.entries(cfg.apiKeys)) {
        if (!process.env[envVar] && typeof value === "string") {
          process.env[envVar] = value;
        }
      }
    }
    if (cfg.endpoints) {
      for (const [envVar, value] of Object.entries(cfg.endpoints)) {
        if (!process.env[envVar] && typeof value === "string") {
          process.env[envVar] = value;
        }
      }
    }
  } catch {
    // Silently ignore config load failures
  }
}

loadStoredApiKeys();

// Check for MCP mode before loading heavy dependencies
const isMcpMode = process.argv.includes("--mcp");

// Handle Ctrl+C gracefully during interactive prompts
function handlePromptExit(err: unknown): void {
  if (err && typeof err === "object" && "name" in err && err.name === "ExitPromptError") {
    console.log("");
    process.exit(0);
  }
  throw err;
}

// Check for auth and profile management commands
const args = process.argv.slice(2);

// Check for subcommands (can appear anywhere in args due to aliases like `claudish -y`)
const isUpdateCommand = args.includes("update");
const isInitCommand = args[0] === "init" || args.includes("init");
const isProfileCommand =
  args[0] === "profile" ||
  args.some((a, i) => a === "profile" && (i === 0 || !args[i - 1]?.startsWith("-")));
// Find first positional (non-flag) arg — handles aliases like `claudish -y config`
const firstPositional = args.find((a) => !a.startsWith("-"));
// Check for telemetry management subcommand
const isTelemetryCommand = firstPositional === "telemetry";
// Check for stats management subcommand
const isStatsCommand = firstPositional === "stats";
// Check for interactive config TUI
const isConfigCommand = firstPositional === "config";
// Auth subcommands: claudish login [provider], claudish logout [provider]
const isLoginCommand = firstPositional === "login";
const isLogoutCommand = firstPositional === "logout";
// Quota subcommand: claudish quota [provider]
const isQuotaCommand = firstPositional === "quota" || firstPositional === "usage";
// Legacy auth flags (deprecated, redirect to new subcommands)
const isLegacyGeminiLogin = args.includes("--gemini-login");
const isLegacyGeminiLogout = args.includes("--gemini-logout");
const isLegacyKimiLogin = args.includes("--kimi-login");
const isLegacyKimiLogout = args.includes("--kimi-logout");

if (isMcpMode) {
  // MCP server mode - dynamic import to keep CLI fast
  import("./mcp-server.js").then((mcp) => mcp.startMcpServer());
} else if (isLoginCommand) {
  // Auth login subcommand: claudish login [provider]
  const loginProviderArg = args.find((a, i) => i > args.indexOf("login") && !a.startsWith("-"));
  import("./auth/auth-commands.js").then((m) =>
    m.loginCommand(loginProviderArg).catch(handlePromptExit)
  );
} else if (isLogoutCommand) {
  // Auth logout subcommand: claudish logout [provider]
  const logoutProviderArg = args.find((a, i) => i > args.indexOf("logout") && !a.startsWith("-"));
  import("./auth/auth-commands.js").then((m) =>
    m.logoutCommand(logoutProviderArg).catch(handlePromptExit)
  );
} else if (isLegacyGeminiLogin || isLegacyKimiLogin) {
  // Deprecated --*-login flags — redirect to new subcommands
  const provider = isLegacyGeminiLogin ? "gemini" : "kimi";
  console.log(`Note: --${provider}-login is deprecated. Use: claudish login ${provider}`);
  import("./auth/auth-commands.js").then((m) => m.loginCommand(provider).catch(handlePromptExit));
} else if (isLegacyGeminiLogout || isLegacyKimiLogout) {
  // Deprecated --*-logout flags — redirect to new subcommands
  const provider = isLegacyGeminiLogout ? "gemini" : "kimi";
  console.log(`Note: --${provider}-logout is deprecated. Use: claudish logout ${provider}`);
  import("./auth/auth-commands.js").then((m) => m.logoutCommand(provider).catch(handlePromptExit));
} else if (isQuotaCommand) {
  // Quota/usage subcommand: claudish quota [provider]
  const quotaProviderArg = args.find(
    (a, i) => i > args.indexOf(firstPositional!) && !a.startsWith("-")
  );
  import("./auth/quota-command.js").then((m) => m.quotaCommand(quotaProviderArg));
} else if (isUpdateCommand) {
  // Self-update command (checked early to work with aliases like `claudish -y update`)
  import("./update-command.js").then((m) => m.updateCommand());
} else if (isInitCommand) {
  // Profile setup wizard — pass --local/--global scope flag if provided
  const scopeFlag = args.includes("--local")
    ? "local"
    : args.includes("--global")
      ? "global"
      : undefined;
  import("./profile-commands.js").then((pc) => pc.initCommand(scopeFlag).catch(handlePromptExit));
} else if (isProfileCommand) {
  // Profile management commands
  const profileArgIndex = args.findIndex((a) => a === "profile");
  import("./profile-commands.js").then((pc) =>
    pc.profileCommand(args.slice(profileArgIndex + 1)).catch(handlePromptExit)
  );
} else if (isTelemetryCommand) {
  // Telemetry management: claudish telemetry on|off|status|reset
  const subcommand = args[1] ?? "status";
  import("./telemetry.js").then((tel) => {
    tel.initTelemetry({ interactive: true } as any);
    return tel.handleTelemetryCommand(subcommand);
  });
} else if (isStatsCommand) {
  // Stats management: claudish stats on|off|status|reset
  const subcommand = args[1] ?? "status";
  import("./stats.js").then((stats) => {
    stats.initStats({ interactive: true } as any);
    return stats.handleStatsCommand(subcommand);
  });
} else if (isConfigCommand) {
  // Interactive configuration TUI: claudish config (full-screen btop-inspired TUI)
  import("./tui/index.js").then((m) => m.startConfigTui().catch(handlePromptExit));
} else {
  // CLI mode
  runCli();
}

/**
 * Run CLI mode
 */
async function runCli() {
  const { checkClaudeInstalled, runClaudeWithProxy } = await import("./claude-runner.js");
  const { parseArgs, getVersion } = await import("./cli.js");
  const { DEFAULT_PORT_RANGE, ENV } = await import("./config.js");
  const { getModelMapping } = await import("./profile-config.js");
  const { selectModel, promptForApiKey } = await import("./model-selector.js");
  const {
    resolveModelProvider,
    validateApiKeysForModels,
    getMissingKeyResolutions,
    getMissingKeysError,
  } = await import("./providers/provider-resolver.js");
  const { initLogger, getLogFilePath, getAlwaysOnLogPath, setDiagOutput } = await import(
    "./logger.js"
  );
  const { createDiagOutput } = await import("./diag-output.js");
  const { findAvailablePort } = await import("./port-manager.js");
  const { createProxyServer } = await import("./proxy-server.js");
  const { checkForUpdates } = await import("./update-checker.js");
  const { warmCatalogIfNeeded } = await import("./launcher/catalog-warm.js");

  /**
   * Read content from stdin
   */
  async function readStdin(): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf-8");
  }

  try {
    // Parse CLI arguments
    const cliConfig = await parseArgs(process.argv.slice(2));

    // Team mode: run models in parallel (skip normal Claude Code path)
    if (cliConfig.team && cliConfig.team.length > 0) {
      // Resolve prompt: --file flag, or positional args from claudeArgs
      let prompt = cliConfig.claudeArgs.join(" ");
      if (cliConfig.inputFile) {
        prompt = readFileSync(cliConfig.inputFile, "utf-8");
      }
      if (!prompt.trim()) {
        console.error("Error: --team requires a prompt (positional args or -f <file>)");
        process.exit(1);
      }

      const mode = cliConfig.teamMode ?? "default";
      const sessionPath = join(process.cwd(), `.claudish-team-${Date.now()}`);

      if (mode === "json") {
        // JSON mode: run models without grid, collect JSON output to stdout
        const { setupSession, runModels } = await import("./team-orchestrator.js");
        setupSession(sessionPath, cliConfig.team, prompt);
        const status = await runModels(sessionPath, {
          timeout: 300,
          claudeFlags: ["--json"],
        });

        // Build JSON result with model responses included
        const result: Record<string, unknown> = { ...status, responses: {} };
        for (const anonId of Object.keys(status.models)) {
          const responsePath = join(sessionPath, `response-${anonId}.md`);
          try {
            const raw = readFileSync(responsePath, "utf-8").trim();
            try {
              (result.responses as Record<string, unknown>)[anonId] = JSON.parse(raw);
            } catch {
              (result.responses as Record<string, unknown>)[anonId] = raw;
            }
          } catch {
            (result.responses as Record<string, unknown>)[anonId] = null;
          }
        }
        console.log(JSON.stringify(result, null, 2));
        process.exit(0);
      }

      // Default or interactive mode — both use magmux grid
      const { runWithGrid } = await import("./team-grid.js");
      const keep = cliConfig.teamKeep ?? false;
      const status = await runWithGrid(sessionPath, cliConfig.team, prompt, {
        timeout: 300,
        keep,
        mode: mode as "default" | "interactive",
      });

      // Print final status (interactive may not reach here until user quits magmux)
      const modelIds = Object.keys(status.models).sort();
      console.log(`\nTeam Status`);
      for (const id of modelIds) {
        const m = status.models[id];
        const duration =
          m.startedAt && m.completedAt
            ? `${Math.round((new Date(m.completedAt).getTime() - new Date(m.startedAt).getTime()) / 1000)}s`
            : "pending";
        console.log(`  ${id}  ${m.state.padEnd(10)}  ${duration}`);
      }
      process.exit(0);
    }

    // First-run auto-approve confirmation
    // Auto-approve is enabled by default, but on first run we confirm with the user.
    // If user explicitly passed --no-auto-approve, skip the prompt entirely.
    // If --stdin is set, skip the prompt — no human to confirm when piping input.
    const rawArgs = process.argv.slice(2);
    const explicitNoAutoApprove = rawArgs.includes("--no-auto-approve");
    if (cliConfig.autoApprove && !explicitNoAutoApprove && !cliConfig.stdin) {
      const { loadConfig, saveConfig } = await import("./profile-config.js");
      try {
        const cfg = loadConfig();
        if (!cfg.autoApproveConfirmedAt) {
          // First run — show one-time confirmation
          const { createInterface } = await import("node:readline");
          process.stderr.write(
            "\n[claudish] Auto-approve is enabled by default.\n" +
              "  This skips Claude Code permission prompts for tools like Bash, Read, Write.\n" +
              "  You can disable it anytime with: --no-auto-approve\n\n"
          );
          const answer = await new Promise<string>((resolve) => {
            const rl = createInterface({ input: process.stdin, output: process.stderr });
            rl.question("Enable auto-approve? [Y/n] ", (ans) => {
              rl.close();
              resolve(ans.trim().toLowerCase());
            });
          });
          const declined = answer === "n" || answer === "no";
          if (declined) {
            cliConfig.autoApprove = false;
            process.stderr.write("[claudish] Auto-approve disabled. Use -y to enable per-run.\n\n");
          } else {
            process.stderr.write("[claudish] Auto-approve confirmed.\n\n");
          }
          cfg.autoApproveConfirmedAt = new Date().toISOString();
          saveConfig(cfg);
        }
      } catch {
        // Config read/write failure — proceed with default (auto-approve on)
      }
    }

    // Initialize logger: always-on structural logging + optional debug logging
    initLogger(cliConfig.debug, cliConfig.logLevel, cliConfig.noLogs);

    // Initialize telemetry (reads consent, generates session_id)
    // Must come after parseArgs() so cliConfig.interactive is known
    const { initTelemetry } = await import("./telemetry.js");
    initTelemetry(cliConfig);

    // Initialize anonymous usage stats (reads consent, detects environment)
    const { initStats, showMonthlyBanner } = await import("./stats.js");
    initStats(cliConfig);
    showMonthlyBanner();

    // Show debug log location if enabled
    if (cliConfig.debug && !cliConfig.quiet) {
      const logFile = getLogFilePath();
      if (logFile) {
        console.log(`[claudish] Debug log: ${logFile}`);
      }
    }

    // Check for updates (only in interactive mode, skip in JSON output mode)
    if (cliConfig.interactive && !cliConfig.jsonOutput) {
      await checkForUpdates(getVersion(), { quiet: cliConfig.quiet });
      const { checkModelFreshness } = await import("./providers/model-freshness.js");
      await checkModelFreshness({
        currentFable: process.env[ENV.ANTHROPIC_DEFAULT_FABLE_MODEL],
        currentAstra:
          process.env[ENV.CLAUDISH_MODEL_FABLE] || getModelMapping(cliConfig.profile).fable,
        quiet: cliConfig.quiet,
      });
    }

    // Check if Claude Code is installed
    if (!(await checkClaudeInstalled())) {
      console.error("Error: Claude Code CLI not found");
      console.error("Install it from: https://claude.com/claude-code");
      console.error("");
      console.error("Or if you have a local installation, set CLAUDE_PATH:");
      console.error("  export CLAUDE_PATH=~/.claude/local/claude");
      process.exit(1);
    }

    // Show interactive model selector ONLY when no model configuration exists
    // Skip if: explicit --model, OR profile provides tier mappings (Claude Code uses these internally)
    const hasProfileTiers =
      cliConfig.modelOpus ||
      cliConfig.modelSonnet ||
      cliConfig.modelHaiku ||
      cliConfig.modelFable ||
      cliConfig.modelSubagent;
    if (cliConfig.interactive && !cliConfig.monitor && !cliConfig.model && !hasProfileTiers) {
      cliConfig.model = (await selectModel({ freeOnly: cliConfig.freeOnly }).catch(
        handlePromptExit
      )) as string;
      console.log(""); // Empty line after selection
    }

    // In non-interactive mode, model must be specified (via --model, env var, or profile)
    if (!cliConfig.interactive && !cliConfig.monitor && !cliConfig.model && !hasProfileTiers) {
      console.error("Error: Model must be specified in non-interactive mode");
      console.error("Use --model <model> flag, set CLAUDISH_MODEL env var, or use --profile");
      console.error("Try: claudish --list-models");
      process.exit(1);
    }

    // === API Key Validation ===
    // This happens AFTER model selection so we know exactly which provider(s) are being used
    // The centralized ProviderResolver handles all provider detection and key requirements
    if (!cliConfig.monitor) {
      // When --model is explicitly set, it overrides ALL role mappings (opus/sonnet/haiku/fable/subagent)
      // So we only need to validate the explicit model, not the profile mappings
      const hasExplicitModel = typeof cliConfig.model === "string";

      // Collect models to validate
      const modelsToValidate = hasExplicitModel
        ? [cliConfig.model] // Only validate the explicit model
        : [
            cliConfig.model,
            cliConfig.modelOpus,
            cliConfig.modelSonnet,
            cliConfig.modelHaiku,
            cliConfig.modelFable,
            cliConfig.modelSubagent,
          ];

      // Validate API keys for all models
      const resolutions = validateApiKeysForModels(modelsToValidate);
      const missingKeys = getMissingKeyResolutions(resolutions);

      if (missingKeys.length > 0) {
        if (cliConfig.interactive) {
          // Interactive mode: prompt for missing OpenRouter key if that's what's needed
          const needsOpenRouter = missingKeys.some((r) => r.category === "openrouter");
          if (needsOpenRouter && !cliConfig.openrouterApiKey) {
            cliConfig.openrouterApiKey = await promptForApiKey();
            console.log(""); // Empty line after input

            // Re-validate after getting the key (it's now in process.env)
            process.env.OPENROUTER_API_KEY = cliConfig.openrouterApiKey;
          }

          // Check if there are still missing keys (non-OpenRouter providers)
          const stillMissing = getMissingKeyResolutions(validateApiKeysForModels(modelsToValidate));
          const nonOpenRouterMissing = stillMissing.filter((r) => r.category !== "openrouter");

          if (nonOpenRouterMissing.length > 0) {
            // Can't prompt for other providers - show error
            console.error(getMissingKeysError(nonOpenRouterMissing));
            process.exit(1);
          }
        } else {
          // Non-interactive mode: fail with clear error message
          console.error(getMissingKeysError(missingKeys));
          process.exit(1);
        }
      }
    }

    // Clean up stdin after interactive prompts (readline, @inquirer/prompts).
    // These leave lingering data/keypress listeners and raw mode state that interfere
    // with Claude Code's TTY handling when spawned with stdio: "inherit". (#85, #88, #99)
    if (cliConfig.interactive && !cliConfig.monitor && process.stdin.isTTY) {
      if (typeof process.stdin.setRawMode === "function") {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
      process.stdin.removeAllListeners("data");
      process.stdin.removeAllListeners("keypress");
    }

    // Show deprecation warnings for legacy syntax
    if (!cliConfig.quiet) {
      const modelsToCheck = [
        cliConfig.model,
        cliConfig.modelOpus,
        cliConfig.modelSonnet,
        cliConfig.modelHaiku,
        cliConfig.modelFable,
        cliConfig.modelSubagent,
      ].filter((m): m is string => typeof m === "string");

      for (const modelId of modelsToCheck) {
        const resolution = resolveModelProvider(modelId);
        if (resolution.deprecationWarning) {
          console.warn(`[claudish] ${resolution.deprecationWarning}`);
        }
      }
    }

    // Read prompt from stdin if --stdin flag is set
    if (cliConfig.stdin) {
      const stdinInput = await readStdin();
      if (stdinInput.trim()) {
        // Prepend stdin content to claudeArgs
        cliConfig.claudeArgs = [stdinInput, ...cliConfig.claudeArgs];
      }
    }

    // Launcher catalog warm step. Runs BEFORE port resolution / proxy startup
    // so we can exit cleanly without a half-spawned server when the catalog
    // is missing AND the network is unreachable. See architecture.md §2.4.
    //
    // Returns one of:
    //   "ok"        — catalog ready (fresh or freshly refreshed)
    //   "warned"    — proceed with stale cache, warning already on stderr
    //   "skipped"   — local model or --skip-models-update
    //   "hard_fail" — missing cache + network failure → exit 1
    const warmOutcome = await warmCatalogIfNeeded(cliConfig);
    if (warmOutcome === "hard_fail") {
      process.exit(1);
    }

    // Find available port
    const port =
      cliConfig.port || (await findAvailablePort(DEFAULT_PORT_RANGE.start, DEFAULT_PORT_RANGE.end));

    // Start proxy server
    // explicitModel is the default/fallback model
    // modelMap provides per-role overrides (opus/sonnet/haiku/fable) that take priority
    const explicitModel = typeof cliConfig.model === "string" ? cliConfig.model : undefined;
    // Always pass modelMap - role mappings should work even when a default model is set
    const modelMap = {
      opus: cliConfig.modelOpus,
      sonnet: cliConfig.modelSonnet,
      haiku: cliConfig.modelHaiku,
      fable: cliConfig.modelFable,
      subagent: cliConfig.modelSubagent,
    };

    const proxy = await createProxyServer(
      port,
      cliConfig.monitor ? undefined : cliConfig.openrouterApiKey!,
      cliConfig.monitor ? undefined : explicitModel,
      cliConfig.monitor,
      cliConfig.anthropicApiKey,
      modelMap,
      {
        summarizeTools: cliConfig.summarizeTools,
        quiet: cliConfig.quiet,
        isInteractive: cliConfig.interactive,
        advisorModels: cliConfig.advisorModels,
        advisorCollector: cliConfig.advisorCollector,
      }
    );

    // Route diagnostic output to log file
    const diag = createDiagOutput({
      interactive: cliConfig.interactive,
      diagMode: cliConfig.diagMode,
    });
    if (cliConfig.interactive) {
      setDiagOutput(diag);
    }

    // Run Claude Code with proxy
    let exitCode = 0;
    try {
      exitCode = await runClaudeWithProxy(cliConfig, proxy.url, () => diag.cleanup());
    } finally {
      // Clear diagOutput BEFORE cleanup to prevent write-after-end
      setDiagOutput(null);
      diag.cleanup();
      // Always cleanup proxy
      if (!cliConfig.quiet) {
        console.log("\n[claudish] Shutting down proxy server...");
      }
      await proxy.shutdown();
    }

    if (!cliConfig.quiet) {
      console.log("[claudish] Done\n");
    }

    // Suggest sending logs if session had errors
    const sessionLogPath = getAlwaysOnLogPath();
    if (exitCode !== 0 && sessionLogPath && !cliConfig.quiet) {
      console.error(`\n[claudish] Session ended with errors. Log: ${sessionLogPath}`);
      console.error(`[claudish] To review: /debug-logs ${sessionLogPath}`);
    }

    process.exit(exitCode);
  } catch (error) {
    console.error("[claudish] Fatal error:", error);
    console.error("[claudish] Stack:", error instanceof Error ? error.stack : "no stack");
    process.exit(1);
  }
}
