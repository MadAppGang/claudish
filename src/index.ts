#!/usr/bin/env node

// Load .env file before anything else (quiet mode to suppress verbose output)
import { config } from "dotenv";
config({ quiet: true }); // Loads .env from current working directory

// Check for MCP mode before loading heavy dependencies
const isMcpMode = process.argv.includes("--mcp");

// Check for auth and profile management commands
const args = process.argv.slice(2);
const firstArg = args[0];

// Auth commands (--gemini-login, --gemini-logout)
const isGeminiLogin = args.includes("--gemini-login");
const isGeminiLogout = args.includes("--gemini-logout");
const isKimiLogin = args.includes("--kimi-login");
const isKimiLogout = args.includes("--kimi-logout");

if (isMcpMode) {
  // MCP server mode - dynamic import to keep CLI fast
  import("./mcp-server.js").then((mcp) => mcp.startMcpServer());
} else if (isGeminiLogin) {
  // Gemini OAuth login
  import("./auth/gemini-oauth.js").then(async ({ GeminiOAuth }) => {
    try {
      const oauth = GeminiOAuth.getInstance();
      await oauth.login();
      console.log("\n✅ Gemini OAuth login successful!");
      console.log("You can now use Gemini Code Assist with: claudish --model go@gemini-2.5-flash");
      process.exit(0);
    } catch (error) {
      console.error("\n❌ Gemini OAuth login failed:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });
} else if (isGeminiLogout) {
  // Gemini OAuth logout
  import("./auth/gemini-oauth.js").then(async ({ GeminiOAuth }) => {
    try {
      const oauth = GeminiOAuth.getInstance();
      await oauth.logout();
      console.log("✅ Gemini OAuth credentials cleared.");
      process.exit(0);
    } catch (error) {
      console.error("❌ Gemini OAuth logout failed:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });
} else if (isKimiLogin) {
  // Kimi OAuth login (Device Authorization Grant)
  import("./auth/kimi-oauth.js").then(async ({ KimiOAuth }) => {
    try {
      const oauth = KimiOAuth.getInstance();
      await oauth.login();
      console.log("\n✅ Kimi OAuth login successful!");
      console.log("You can now use Kimi with: claudish --model kimi@kimi-k2-thinking-turbo");
      process.exit(0);
    } catch (error) {
      console.error("\n❌ Kimi OAuth login failed:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });
} else if (isKimiLogout) {
  // Kimi OAuth logout
  import("./auth/kimi-oauth.js").then(async ({ KimiOAuth }) => {
    try {
      const oauth = KimiOAuth.getInstance();
      await oauth.logout();
      console.log("✅ Kimi OAuth credentials cleared.");
      process.exit(0);
    } catch (error) {
      console.error("❌ Kimi OAuth logout failed:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });
} else if (firstArg === "init") {
  // Profile setup wizard
  import("./profile-commands.js").then((pc) => pc.initCommand());
} else if (firstArg === "profile") {
  // Profile management commands
  import("./profile-commands.js").then((pc) => pc.profileCommand(args.slice(1)));
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
  const { DEFAULT_PORT_RANGE } = await import("./config.js");
  const { selectModel, promptForApiKey } = await import("./model-selector.js");
  const {
    resolveModelProvider,
    validateApiKeysForModels,
    getMissingKeyResolutions,
    getMissingKeysError,
  } = await import("./providers/provider-resolver.js");
  const { initLogger, getLogFilePath } = await import("./logger.js");
  const { findAvailablePort } = await import("./port-manager.js");
  const { createProxyServer } = await import("./proxy-server.js");
  const { checkForUpdates } = await import("./update-checker.js");

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

    // Initialize logger if debug mode with specified log level
    initLogger(cliConfig.debug, cliConfig.logLevel);

    // Show debug log location if enabled
    if (cliConfig.debug && !cliConfig.quiet) {
      const logFile = getLogFilePath();
      if (logFile) {
        console.log(`[claudish] Debug log: ${logFile}`);
      }
    }

    // Check for updates (only in interactive mode, skip in JSON output mode)
    if (cliConfig.interactive && !cliConfig.jsonOutput) {
      const shouldExit = await checkForUpdates(getVersion(), {
        quiet: cliConfig.quiet,
        skipPrompt: false,
      });
      if (shouldExit) {
        process.exit(0);
      }
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

    // Show interactive model selector ONLY in interactive mode when model not specified
    if (cliConfig.interactive && !cliConfig.monitor && !cliConfig.model) {
      cliConfig.model = await selectModel({ freeOnly: cliConfig.freeOnly });
      console.log(""); // Empty line after selection
    }

    // In non-interactive mode, model must be specified (via --model flag or CLAUDISH_MODEL env var)
    if (!cliConfig.interactive && !cliConfig.monitor && !cliConfig.model) {
      console.error("Error: Model must be specified in non-interactive mode");
      console.error("Use --model <model> flag or set CLAUDISH_MODEL environment variable");
      console.error("Try: claudish --list-models");
      process.exit(1);
    }

    // === Kimi Coding OAuth Auto-Login ===
    // If any model routes to kimi-coding, ensure OAuth credentials exist
    if (!cliConfig.monitor) {
      const { parseModelSpec } = await import("./providers/model-parser.js");
      const allModels = [
        cliConfig.model,
        cliConfig.modelOpus,
        cliConfig.modelSonnet,
        cliConfig.modelHaiku,
        cliConfig.modelSubagent,
      ].filter((m): m is string => typeof m === "string");

      const needsKimiCoding = allModels.some(
        (m) => parseModelSpec(m).provider === "kimi-coding"
      );

      if (needsKimiCoding) {
        const { KimiOAuth } = await import("./auth/kimi-oauth.js");
        const oauth = KimiOAuth.getInstance();
        if (!oauth.hasCredentials()) {
          if (!cliConfig.quiet) {
            console.log("[claudish] Kimi Coding requires OAuth login. Starting login flow...\n");
          }
          try {
            await oauth.login();
            if (!cliConfig.quiet) {
              console.log("\n[claudish] Kimi OAuth login successful!\n");
            }
          } catch (error) {
            console.error("\nKimi OAuth login failed:", error instanceof Error ? error.message : error);
            process.exit(1);
          }
        }
      }
    }

    // === API Key Validation ===
    // This happens AFTER model selection so we know exactly which provider(s) are being used
    // The centralized ProviderResolver handles all provider detection and key requirements
    if (!cliConfig.monitor) {
      // When --model is explicitly set, it overrides ALL role mappings (opus/sonnet/haiku/subagent)
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

    // Show deprecation warnings for legacy syntax
    if (!cliConfig.quiet) {
      const modelsToCheck = [
        cliConfig.model,
        cliConfig.modelOpus,
        cliConfig.modelSonnet,
        cliConfig.modelHaiku,
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

    // Find available port
    const port =
      cliConfig.port || (await findAvailablePort(DEFAULT_PORT_RANGE.start, DEFAULT_PORT_RANGE.end));

    // Start proxy server
    // explicitModel is the default/fallback model
    // modelMap provides per-role overrides (opus/sonnet/haiku) that take priority
    const explicitModel = typeof cliConfig.model === "string" ? cliConfig.model : undefined;
    // Always pass modelMap - role mappings should work even when a default model is set
    const modelMap = {
      opus: cliConfig.modelOpus,
      sonnet: cliConfig.modelSonnet,
      haiku: cliConfig.modelHaiku,
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
      }
    );

    // Run Claude Code with proxy
    let exitCode = 0;
    try {
      exitCode = await runClaudeWithProxy(cliConfig, proxy.url);
    } finally {
      // Always cleanup proxy
      if (!cliConfig.quiet) {
        console.log("\n[claudish] Shutting down proxy server...");
      }
      await proxy.shutdown();
    }

    if (!cliConfig.quiet) {
      console.log("[claudish] Done\n");
    }

    process.exit(exitCode);
  } catch (error) {
    console.error("[claudish] Fatal error:", error);
    process.exit(1);
  }
}
