import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { ENV } from "./config.js";
import type { ClaudishConfig } from "./types.js";

// Use process.platform directly to ensure runtime evaluation
// (module-level constants can be inlined by bundlers at build time)
function isWindows(): boolean {
  return process.platform === "win32";
}

/**
 * Create a cross-platform Node.js script for status line
 * This replaces the bash script to work on Windows
 */
function createStatusLineScript(tokenFilePath: string): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || tmpdir();
  const claudishDir = join(homeDir, ".claudish");
  const timestamp = Date.now();
  const scriptPath = join(claudishDir, `status-${timestamp}.js`);

  // Escape backslashes for Windows paths in the script
  const escapedTokenPath = tokenFilePath.replace(/\\/g, "\\\\");

  const script = `
const fs = require('fs');
const path = require('path');

const CYAN = "\\x1b[96m";
const YELLOW = "\\x1b[93m";
const GREEN = "\\x1b[92m";
const MAGENTA = "\\x1b[95m";
const DIM = "\\x1b[2m";
const RESET = "\\x1b[0m";
const BOLD = "\\x1b[1m";

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  try {
    let dir = path.basename(process.cwd());
    if (dir.length > 15) dir = dir.substring(0, 12) + '...';

    let ctx = 100, cost = 0;
    const model = process.env.CLAUDISH_ACTIVE_MODEL_NAME || 'unknown';
    const isLocal = process.env.CLAUDISH_IS_LOCAL === 'true';

    try {
      const tokens = JSON.parse(fs.readFileSync('${escapedTokenPath}', 'utf-8'));
      cost = tokens.total_cost || 0;
      ctx = tokens.context_left_percent || 100;
    } catch (e) {
      try {
        const json = JSON.parse(input);
        cost = json.total_cost_usd || 0;
      } catch {}
    }

    const costDisplay = isLocal ? 'LOCAL' : ('$' + cost.toFixed(3));
    console.log(\`\${CYAN}\${BOLD}\${dir}\${RESET} \${DIM}•\${RESET} \${YELLOW}\${model}\${RESET} \${DIM}•\${RESET} \${GREEN}\${costDisplay}\${RESET} \${DIM}•\${RESET} \${MAGENTA}\${ctx}%\${RESET}\`);
  } catch (e) {
    console.log('claudish');
  }
});
`;

  writeFileSync(scriptPath, script, "utf-8");
  return scriptPath;
}

/**
 * Create a temporary settings file with custom status line for this instance
 * This ensures each Claudish instance has its own status line without affecting
 * global Claude Code settings or other running instances
 *
 * Note: We use ~/.claudish/ instead of system temp directory to avoid Claude Code's
 * file watcher trying to watch socket files in /tmp (which causes UNKNOWN errors)
 */
function createTempSettingsFile(modelDisplay: string, port: string): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || tmpdir();
  const claudishDir = join(homeDir, ".claudish");

  // Ensure .claudish directory exists
  try {
    mkdirSync(claudishDir, { recursive: true });
  } catch {
    // Directory may already exist
  }

  const timestamp = Date.now();
  const tempPath = join(claudishDir, `settings-${timestamp}.json`);

  // Token file path - also in .claudish directory
  const tokenFilePath = join(claudishDir, `tokens-${port}.json`);

  let statusCommand: string;

  if (isWindows()) {
    // Windows: Use Node.js script for cross-platform compatibility
    const scriptPath = createStatusLineScript(tokenFilePath);
    statusCommand = `node "${scriptPath}"`;
  } else {
    // Unix: Use optimized bash script
    // ANSI color codes for visual enhancement
    const CYAN = "\\033[96m";
    const YELLOW = "\\033[93m";
    const GREEN = "\\033[92m";
    const MAGENTA = "\\033[95m";
    const DIM = "\\033[2m";
    const RESET = "\\033[0m";
    const BOLD = "\\033[1m";

    // Cost comes from Claude CLI's total_cost_usd (we don't track cost in token file)
    // Context percentage comes from our token file
    statusCommand = `JSON=$(cat) && DIR=$(basename "$(pwd)") && [ \${#DIR} -gt 15 ] && DIR="\${DIR:0:12}..." || true && CTX=100 && COST="0" && if [ -f "${tokenFilePath}" ]; then TOKENS=$(cat "${tokenFilePath}" 2>/dev/null) && REAL_CTX=$(echo "$TOKENS" | grep -o '"context_left_percent":[0-9]*' | grep -o '[0-9]*') && if [ ! -z "$REAL_CTX" ]; then CTX="$REAL_CTX"; fi; fi && COST=$(echo "$JSON" | grep -o '"total_cost_usd":[0-9.]*' | cut -d: -f2) && [ -z "$COST" ] && COST="0" || true && if [ "$CLAUDISH_IS_LOCAL" = "true" ]; then COST_DISPLAY="LOCAL"; else COST_DISPLAY=$(printf "\\$%.3f" "$COST"); fi && printf "${CYAN}${BOLD}%s${RESET} ${DIM}•${RESET} ${YELLOW}%s${RESET} ${DIM}•${RESET} ${GREEN}%s${RESET} ${DIM}•${RESET} ${MAGENTA}%s%%${RESET}\\n" "$DIR" "$CLAUDISH_ACTIVE_MODEL_NAME" "$COST_DISPLAY" "$CTX"`;
  }

  const settings = {
    statusLine: {
      type: "command",
      command: statusCommand,
      padding: 0,
    },
  };

  writeFileSync(tempPath, JSON.stringify(settings, null, 2), "utf-8");
  return tempPath;
}

/**
 * Run Claude Code CLI with the proxy server
 */
export async function runClaudeWithProxy(
  config: ClaudishConfig,
  proxyUrl: string
): Promise<number> {
  // Use actual OpenRouter model ID (no translation)
  // This ensures ANY model works, not just our shortlist
  const modelId = config.model || "unknown";

  // Extract port from proxy URL for token file path
  const portMatch = proxyUrl.match(/:(\d+)/);
  const port = portMatch ? portMatch[1] : "unknown";

  // Create temporary settings file with custom status line for this instance
  const tempSettingsPath = createTempSettingsFile(modelId, port);

  // Build claude arguments
  const claudeArgs: string[] = [];

  // Add settings file flag first (applies to this instance only)
  claudeArgs.push("--settings", tempSettingsPath);

  // Interactive mode - no automatic arguments
  if (config.interactive) {
    // In interactive mode, add permission skip if enabled
    if (config.autoApprove) {
      claudeArgs.push("--dangerously-skip-permissions");
    }
    if (config.dangerous) {
      claudeArgs.push("--dangerouslyDisableSandbox");
    }
  } else {
    // Single-shot mode - add all arguments
    // Add -p flag FIRST to enable headless/print mode (non-interactive, exits after task)
    claudeArgs.push("-p");
    if (config.autoApprove) {
      claudeArgs.push("--dangerously-skip-permissions");
    }
    if (config.dangerous) {
      claudeArgs.push("--dangerouslyDisableSandbox");
    }
    // Add JSON output format if requested
    if (config.jsonOutput) {
      claudeArgs.push("--output-format", "json");
    }
    // If agent is specified, prepend agent instruction to the prompt
    if (config.agent && config.claudeArgs.length > 0) {
      // Prepend agent context to the first argument (the prompt)
      // This tells Claude Code to use the specified agent for the task
      // Claude Code agents use @agent- prefix format
      const modifiedArgs = [...config.claudeArgs];
      const agentId = config.agent.startsWith("@agent-") ? config.agent : `@agent-${config.agent}`;
      modifiedArgs[0] = `Use the ${agentId} agent to: ${modifiedArgs[0]}`;
      claudeArgs.push(...modifiedArgs);
    } else {
      // Add user-provided args as-is (including prompt)
      claudeArgs.push(...config.claudeArgs);
    }
  }

  // Check if this is a local model (ollama/, lmstudio/, vllm/, mlx/, or http:// URL)
  const isLocalModel =
    modelId.startsWith("ollama/") ||
    modelId.startsWith("ollama:") ||
    modelId.startsWith("lmstudio/") ||
    modelId.startsWith("lmstudio:") ||
    modelId.startsWith("vllm/") ||
    modelId.startsWith("vllm:") ||
    modelId.startsWith("mlx/") ||
    modelId.startsWith("mlx:") ||
    modelId.startsWith("http://") ||
    modelId.startsWith("https://");

  // Environment variables for Claude Code
  const env: Record<string, string> = {
    ...process.env,
    // Point Claude Code to our local proxy
    ANTHROPIC_BASE_URL: proxyUrl,
    // Set active model ID for status line (actual OpenRouter model ID)
    [ENV.CLAUDISH_ACTIVE_MODEL_NAME]: modelId,
    // Indicate if this is a local model (for status line to show "LOCAL" instead of cost)
    CLAUDISH_IS_LOCAL: isLocalModel ? "true" : "false",
    // Set Claude Code standard model environment variables
    // Both ANTHROPIC_MODEL and ANTHROPIC_SMALL_FAST_MODEL point to the same model
    // since we're proxying everything through OpenRouter
    [ENV.ANTHROPIC_MODEL]: modelId,
    [ENV.ANTHROPIC_SMALL_FAST_MODEL]: modelId,
  };

  // Handle API key based on mode
  if (config.monitor) {
    // Monitor mode: Don't set ANTHROPIC_API_KEY at all
    // This allows Claude Code to use its native authentication
    // Delete any placeholder keys from environment
    delete env.ANTHROPIC_API_KEY;
  } else {
    // OpenRouter mode: Use placeholder to prevent Claude Code dialog
    // The proxy will handle authentication with OPENROUTER_API_KEY
    env.ANTHROPIC_API_KEY =
      process.env.ANTHROPIC_API_KEY ||
      "sk-ant-api03-placeholder-not-used-proxy-handles-auth-with-openrouter-key-xxxxxxxxxxxxxxxxxxxxx";
  }

  // Helper function to log messages (respects quiet flag)
  const log = (message: string) => {
    if (!config.quiet) {
      console.log(message);
    }
  };

  if (config.interactive) {
    log(`\n[claudish] Model: ${modelId}\n`);
  } else {
    log(`\n[claudish] Model: ${modelId}`);
    log(`[claudish] Arguments: ${claudeArgs.join(" ")}\n`);
  }

  // Spawn claude CLI process using Node.js child_process (works on both Node.js and Bun)
  // Windows needs shell: true to find .cmd/.bat files like claude.cmd
  const proc = spawn("claude", claudeArgs, {
    env,
    stdio: "inherit", // Stream stdin/stdout/stderr to parent
    shell: isWindows(),
  });

  // Handle process termination signals (includes cleanup)
  setupSignalHandlers(proc, tempSettingsPath, config.quiet);

  // Wait for claude to exit
  const exitCode = await new Promise<number>((resolve) => {
    proc.on("exit", (code) => {
      resolve(code ?? 1);
    });
  });

  // Clean up temporary settings file
  try {
    unlinkSync(tempSettingsPath);
  } catch (error) {
    // Ignore cleanup errors
  }

  return exitCode;
}

/**
 * Setup signal handlers to gracefully shutdown
 */
function setupSignalHandlers(proc: ChildProcess, tempSettingsPath: string, quiet: boolean): void {
  // Windows only supports SIGINT and SIGTERM reliably
  // SIGHUP doesn't exist on Windows
  const signals: NodeJS.Signals[] = isWindows()
    ? ["SIGINT", "SIGTERM"]
    : ["SIGINT", "SIGTERM", "SIGHUP"];

  for (const signal of signals) {
    process.on(signal, () => {
      if (!quiet) {
        console.log(`\n[claudish] Received ${signal}, shutting down...`);
      }
      proc.kill();
      // Clean up temp settings file
      try {
        unlinkSync(tempSettingsPath);
      } catch {
        // Ignore cleanup errors
      }
      process.exit(0);
    });
  }
}

/**
 * Check if Claude Code CLI is installed
 */
export async function checkClaudeInstalled(): Promise<boolean> {
  try {
    const isWindows = process.platform === "win32";
    const command = isWindows ? "where" : "which";

    const proc = spawn(command, ["claude"], {
      stdio: "ignore",
      shell: isWindows, // Windows needs shell for 'where' command
    });

    const exitCode = await new Promise<number>((resolve) => {
      proc.on("exit", (code) => {
        resolve(code ?? 1);
      });
    });

    return exitCode === 0;
  } catch {
    return false;
  }
}
