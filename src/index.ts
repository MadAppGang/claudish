#!/usr/bin/env node

// Load .env file before anything else
import { config } from "dotenv";
config(); // Loads .env from current working directory

// Check for MCP mode before loading heavy dependencies
const isMcpMode = process.argv.includes("--mcp");

// Check for profile management commands
const args = process.argv.slice(2);
const firstArg = args[0];

if (isMcpMode) {
  // MCP server mode - dynamic import to keep CLI fast
  import("./mcp-server.js").then((mcp) => mcp.startMcpServer());
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
  const { initLogger, getLogFilePath, initializeDebugConfig } = await import("./logger.js");
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

    // Initialize enhanced debug configuration from environment variables
    const debugConfig = initializeDebugConfig();

    // Show debug log location if enabled
    if ((cliConfig.debug || debugConfig.enabled) && !cliConfig.quiet) {
      const logFile = getLogFilePath();
      if (logFile) {
        console.log(`[claudish] Debug log: ${logFile}`);
      }
      if (debugConfig.enabled) {
        const enabledComponents = Object.entries(debugConfig.components)
          .filter(([_, enabled]) => enabled)
          .map(([name, _]) => name);
        if (enabledComponents.length > 0) {
          console.log(`[claudish] Debug components: ${enabledComponents.join(', ')}`);
        }
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
      console.error("Error: Claude Code CLI is not installed");
      console.error("Install it from: https://claude.com/claude-code");
      process.exit(1);
    }

    // Prompt for API keys if not set (interactive mode only, not monitor mode)
    // Check which API key is needed based on model selection
    if (cliConfig.interactive && !cliConfig.monitor) {
      const isPoeModel = cliConfig.model?.startsWith("poe:");
      const isOpenRouterModel = cliConfig.model?.includes("/") && !isPoeModel;

      // Prompt for appropriate API key
      if (isPoeModel && !cliConfig.poeApiKey) {
        const { promptForPoeApiKey } = await import("./model-selector.js");
        cliConfig.poeApiKey = await promptForPoeApiKey();
        console.log(""); // Empty line after input
      } else if (isOpenRouterModel && !cliConfig.openrouterApiKey) {
        cliConfig.openrouterApiKey = await promptForApiKey();
        console.log(""); // Empty line after input
      }
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
      console.error("Try: claudish --models");
      process.exit(1);
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
    const proxy = await createProxyServer(
      port,
      cliConfig.monitor ? undefined : cliConfig.openrouterApiKey!,
      cliConfig.monitor
        ? undefined
        : typeof cliConfig.model === "string"
          ? cliConfig.model
          : undefined,
      cliConfig.monitor,
      cliConfig.anthropicApiKey,
      {
        opus: cliConfig.modelOpus,
        sonnet: cliConfig.modelSonnet,
        haiku: cliConfig.modelHaiku,
        subagent: cliConfig.modelSubagent,
      },
      cliConfig.poeApiKey
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
