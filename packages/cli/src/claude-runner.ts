import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { writeFileSync, unlinkSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
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

// Format token count with k/M suffix
function formatTokens(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(n >= 10000000 ? 0 : 1).replace(/\\.0$/, '') + 'M';
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\\.0$/, '') + 'k';
  return String(n);
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  try {
    let dir = path.basename(process.cwd());
    if (dir.length > 15) dir = dir.substring(0, 12) + '...';

    let ctx = 100, cost = 0, inputTokens = 0, contextWindow = 0;
    let model = process.env.CLAUDISH_ACTIVE_MODEL_NAME || 'unknown';
    const isLocal = process.env.CLAUDISH_IS_LOCAL === 'true';

    let isFree = false, isEstimated = false, providerName = '';
    try {
      const tokens = JSON.parse(fs.readFileSync('${escapedTokenPath}', 'utf-8'));
      cost = tokens.total_cost || 0;
      ctx = tokens.context_left_percent || 100;
      inputTokens = tokens.input_tokens || 0;
      contextWindow = tokens.context_window || 0;
      isFree = tokens.is_free || false;
      isEstimated = tokens.is_estimated || false;
      providerName = tokens.provider_name || '';
      if (tokens.model_name) model = tokens.model_name;
    } catch (e) {
      try {
        const json = JSON.parse(input);
        cost = json.total_cost_usd || 0;
      } catch {}
    }

    let costDisplay;
    if (isLocal) {
      costDisplay = 'LOCAL';
    } else if (isFree) {
      costDisplay = 'FREE';
    } else if (isEstimated) {
      costDisplay = '~$' + cost.toFixed(3);
    } else {
      costDisplay = '$' + cost.toFixed(3);
    }
    const modelDisplay = providerName ? providerName + ' ' + model : model;
    // Format context display as progress bar: [████░░░░░░] 116k/1M
    let ctxDisplay = '';
    if (inputTokens > 0 && contextWindow > 0) {
      const usedPct = 100 - ctx; // ctx is "left", so used = 100 - left
      const barWidth = 15;
      const filled = Math.round((usedPct / 100) * barWidth);
      const empty = barWidth - filled;
      const bar = '█'.repeat(filled) + '░'.repeat(empty);
      ctxDisplay = '[' + bar + '] ' + formatTokens(inputTokens) + '/' + formatTokens(contextWindow);
    } else {
      ctxDisplay = ctx + '%';
    }
    console.log(\`\${CYAN}\${BOLD}\${dir}\${RESET} \${DIM}•\${RESET} \${YELLOW}\${modelDisplay}\${RESET} \${DIM}•\${RESET} \${GREEN}\${costDisplay}\${RESET} \${DIM}•\${RESET} \${MAGENTA}\${ctxDisplay}\${RESET}\`);
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
function createTempSettingsFile(
  modelDisplay: string,
  port: string
): { path: string; statusLine: { type: string; command: string; padding: number } } {
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

    // Both cost and context percentage come from our token file
    // Helper function to format tokens with k/M suffix (pure bash, no awk)
    const formatTokensBash = `fmt_tok() { local n=\${1:-0}; if [ "$n" -ge 1000000 ]; then echo "$((n/1000000))M"; elif [ "$n" -ge 1000 ]; then echo "$((n/1000))k"; else echo "$n"; fi; }`;
    statusCommand = `JSON=$(cat) && DIR=$(basename "$(pwd)") && [ \${#DIR} -gt 15 ] && DIR="\${DIR:0:12}..." || true && CTX=100 && COST="0" && IS_FREE="false" && IS_EST="false" && PROVIDER="" && TOKEN_MODEL="" && IN_TOK=0 && CTX_WIN=0 && ${formatTokensBash} && if [ -f "${tokenFilePath}" ]; then TOKENS=$(cat "${tokenFilePath}" 2>/dev/null | tr -d ' \\n') && REAL_CTX=$(echo "$TOKENS" | grep -o '"context_left_percent":[0-9]*' | grep -o '[0-9]*') && if [ ! -z "$REAL_CTX" ]; then CTX="$REAL_CTX"; fi && REAL_COST=$(echo "$TOKENS" | grep -o '"total_cost":[0-9.]*' | cut -d: -f2) && if [ ! -z "$REAL_COST" ]; then COST="$REAL_COST"; fi && IN_TOK=$(echo "$TOKENS" | grep -o '"input_tokens":[0-9]*' | grep -o '[0-9]*') && CTX_WIN=$(echo "$TOKENS" | grep -o '"context_window":[0-9]*' | grep -o '[0-9]*') && IS_FREE=$(echo "$TOKENS" | grep -o '"is_free":[a-z]*' | cut -d: -f2) && IS_EST=$(echo "$TOKENS" | grep -o '"is_estimated":[a-z]*' | cut -d: -f2) && PROVIDER=$(echo "$TOKENS" | grep -o '"provider_name":"[^"]*"' | cut -d'"' -f4) && TOKEN_MODEL=$(echo "$TOKENS" | grep -o '"model_name":"[^"]*"' | cut -d'"' -f4); fi && if [ "$CLAUDISH_IS_LOCAL" = "true" ]; then COST_DISPLAY="LOCAL"; elif [ "$IS_FREE" = "true" ]; then COST_DISPLAY="FREE"; elif [ "$IS_EST" = "true" ]; then COST_DISPLAY=$(printf "~\\$%.3f" "$COST"); else COST_DISPLAY=$(printf "\\$%.3f" "$COST"); fi && MODEL_DISPLAY="\${TOKEN_MODEL:-$CLAUDISH_ACTIVE_MODEL_NAME}" && if [ ! -z "$PROVIDER" ]; then MODEL_DISPLAY="$PROVIDER $MODEL_DISPLAY"; fi && if [ "$IN_TOK" -gt 0 ] 2>/dev/null && [ "$CTX_WIN" -gt 0 ] 2>/dev/null; then CTX_DISPLAY="$CTX% ($(fmt_tok $IN_TOK)/$(fmt_tok $CTX_WIN))"; else CTX_DISPLAY="$CTX%"; fi && printf "${CYAN}${BOLD}%s${RESET} ${DIM}•${RESET} ${YELLOW}%s${RESET} ${DIM}•${RESET} ${GREEN}%s${RESET} ${DIM}•${RESET} ${MAGENTA}%s${RESET}\\n" "$DIR" "$MODEL_DISPLAY" "$COST_DISPLAY" "$CTX_DISPLAY"`;
  }

  const statusLine = {
    type: "command",
    command: statusCommand,
    padding: 0,
  };

  const settings = { statusLine };

  writeFileSync(tempPath, JSON.stringify(settings, null, 2), "utf-8");
  return { path: tempPath, statusLine };
}

/**
 * If the user passed --settings in claudeArgs, read their settings file,
 * inject the claudish statusLine into it, write a merged file, and remove
 * --settings from claudeArgs so Claude Code does not receive it twice.
 *
 * The tempSettingsPath is always written by createTempSettingsFile() first.
 * This function REPLACES its content with the merged result when a user
 * settings file exists.
 *
 * Mutates: config.claudeArgs (removes --settings and path if found)
 * Mutates: tempSettingsPath file content (replaces with merged JSON)
 */
function mergeUserSettingsIfPresent(
  config: ClaudishConfig,
  tempSettingsPath: string,
  statusLine: { type: string; command: string; padding: number }
): void {
  const idx = config.claudeArgs.indexOf("--settings");
  if (idx === -1 || !config.claudeArgs[idx + 1]) {
    // No --settings in passthrough args; nothing to merge.
    return;
  }

  const userSettingsValue = config.claudeArgs[idx + 1];

  try {
    // Claude Code accepts --settings as either a file path or an inline JSON string.
    // Detect inline JSON (starts with '{') vs file path.
    let userSettings: Record<string, unknown>;
    if (userSettingsValue.trimStart().startsWith("{")) {
      userSettings = JSON.parse(userSettingsValue);
    } else {
      const rawUserSettings = readFileSync(userSettingsValue, "utf-8");
      userSettings = JSON.parse(rawUserSettings);
    }

    // Inject claudish statusLine into user settings (overrides any existing statusLine)
    userSettings.statusLine = statusLine;

    // Overwrite the temp settings file with the merged result
    writeFileSync(tempSettingsPath, JSON.stringify(userSettings, null, 2), "utf-8");
  } catch {
    // User settings unreadable or invalid JSON — claudish temp file keeps its own statusLine.
    if (!config.quiet) {
      console.warn(`[claudish] Warning: could not merge user settings: ${userSettingsValue}`);
    }
  }

  // Always remove --settings from claudeArgs: either we merged successfully (our temp file
  // contains the merged result), or the user's settings were invalid (let the temp file win
  // rather than passing an unreadable path to Claude Code for a second error).
  config.claudeArgs.splice(idx, 2);
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
  // In profile/multi-model mode, don't set a single model - let Claude Code use its defaults
  // so the proxy can match tier names (opus/sonnet/haiku) and apply profile mappings
  const hasProfileMappings =
    config.modelOpus || config.modelSonnet || config.modelHaiku || config.modelSubagent;
  const modelId = config.model || (hasProfileMappings || config.monitor ? undefined : "unknown");

  // Extract port from proxy URL for token file path
  const portMatch = proxyUrl.match(/:(\d+)/);
  const port = portMatch ? portMatch[1] : "unknown";

  // Create temporary settings file with custom status line for this instance
  const { path: tempSettingsPath, statusLine } = createTempSettingsFile(modelId, port);

  // Merge user's --settings into our temp settings file if user provided one
  mergeUserSettingsIfPresent(config, tempSettingsPath, statusLine);

  // Build claude arguments
  const claudeArgs: string[] = [];

  // Add settings file flag (our merged temp file, applies to this instance only)
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
    // Forward user-provided passthrough args (e.g. --permission-mode, --effort, --add-dir)
    claudeArgs.push(...config.claudeArgs);
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
    // Add user-provided args as-is (including prompt and any Claude Code flags)
    claudeArgs.push(...config.claudeArgs);
  }

  // Check if this is a local model (ollama/, lmstudio/, vllm/, mlx/, or http:// URL)
  const isLocalModel = modelId
    ? modelId.startsWith("ollama/") ||
      modelId.startsWith("ollama:") ||
      modelId.startsWith("lmstudio/") ||
      modelId.startsWith("lmstudio:") ||
      modelId.startsWith("vllm/") ||
      modelId.startsWith("vllm:") ||
      modelId.startsWith("mlx/") ||
      modelId.startsWith("mlx:") ||
      modelId.startsWith("http://") ||
      modelId.startsWith("https://")
    : false;

  // Environment variables for Claude Code
  // For display: show profile name before first request; token file model_name takes over after
  const modelDisplayName = modelId || config.profile || "default";
  const env: Record<string, string> = {
    ...process.env,
    // Point Claude Code to our local proxy
    ANTHROPIC_BASE_URL: proxyUrl,
    // Set active model ID for status line (actual OpenRouter model ID)
    [ENV.CLAUDISH_ACTIVE_MODEL_NAME]: modelDisplayName,
    // Indicate if this is a local model (for status line to show "LOCAL" instead of cost)
    CLAUDISH_IS_LOCAL: isLocalModel ? "true" : "false",
  };

  // Remove Claude Code's nested-session guard variable.
  // When claudish is invoked from within Claude Code, CLAUDECODE is inherited
  // and causes the child Claude Code to refuse to start. Since claudish makes
  // independent API calls through a proxy (not nesting sessions), this is safe.
  delete env.CLAUDECODE;

  // Handle API key and model based on mode
  if (config.monitor) {
    // Monitor mode: Don't set ANTHROPIC_API_KEY at all
    // This allows Claude Code to use its native authentication
    // Delete any placeholder keys from environment
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    // Don't override ANTHROPIC_MODEL - let Claude Code use its default
    // (unless user explicitly specified a model)
    if (modelId) {
      env[ENV.ANTHROPIC_MODEL] = modelId;
      env[ENV.ANTHROPIC_SMALL_FAST_MODEL] = modelId;
    }
  } else {
    // Set Claude Code standard model environment variables
    // When using profile mode (no explicit --model), DON'T override ANTHROPIC_MODEL
    // Let Claude Code use its default model names (e.g., "claude-sonnet-4-5-20250929")
    // so the proxy can match "opus"/"sonnet"/"haiku" in the model name and apply mappings
    if (modelId) {
      env[ENV.ANTHROPIC_MODEL] = modelId;
      env[ENV.ANTHROPIC_SMALL_FAST_MODEL] = modelId;
    }
    // OpenRouter mode: Use placeholder to prevent Claude Code dialog
    // The proxy will handle authentication with OPENROUTER_API_KEY
    env.ANTHROPIC_API_KEY =
      process.env.ANTHROPIC_API_KEY ||
      "sk-ant-api03-placeholder-not-used-proxy-handles-auth-with-openrouter-key-xxxxxxxxxxxxxxxxxxxxx";

    // Also set ANTHROPIC_AUTH_TOKEN to bypass login screen
    // Claude Code checks both API_KEY and AUTH_TOKEN for authentication
    env.ANTHROPIC_AUTH_TOKEN =
      process.env.ANTHROPIC_AUTH_TOKEN || "placeholder-token-not-used-proxy-handles-auth";
  }

  // Helper function to log messages (respects quiet flag)
  const log = (message: string) => {
    if (!config.quiet) {
      console.log(message);
    }
  };

  if (config.interactive) {
    log(`\n[claudish] Model: ${modelDisplayName}\n`);
  } else {
    log(`\n[claudish] Model: ${modelDisplayName}`);
    log(`[claudish] Arguments: ${claudeArgs.join(" ")}\n`);
  }

  // Find Claude binary (supports CLAUDE_PATH, local installation, and global PATH)
  const claudeBinary = await findClaudeBinary();
  if (!claudeBinary) {
    console.error("Error: Claude Code CLI not found");
    console.error("Install it from: https://claude.com/claude-code");
    console.error("\nOr set CLAUDE_PATH to your custom installation:");
    const home = homedir();
    const localPath = isWindows()
      ? join(home, ".claude", "local", "claude.exe")
      : join(home, ".claude", "local", "claude");
    console.error(`  export CLAUDE_PATH=${localPath}`);
    process.exit(1);
  }

  // Spawn claude CLI process using Node.js child_process (works on both Node.js and Bun)
  // On Windows, .cmd files require shell:true — spawn() throws EINVAL without it.
  // When using shell mode, quote the binary path to handle spaces (e.g. "C:\Program Files\...")
  const needsShell = isWindows() && claudeBinary.endsWith(".cmd");
  const spawnCommand = needsShell ? `"${claudeBinary}"` : claudeBinary;
  const proc = spawn(spawnCommand, claudeArgs, {
    env,
    stdio: "inherit", // Stream stdin/stdout/stderr to parent
    shell: needsShell,
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
 * Find Claude Code binary in priority order:
 * 1. CLAUDE_PATH env var
 * 2. Local installation (~/.claude/local/claude)
 * 3. Global PATH
 */
async function findClaudeBinary(): Promise<string | null> {
  const isWindows = process.platform === "win32";

  // 1. Check CLAUDE_PATH env var
  if (process.env.CLAUDE_PATH) {
    if (existsSync(process.env.CLAUDE_PATH)) {
      return process.env.CLAUDE_PATH;
    }
  }

  // 2. Check local installation
  const home = homedir();
  const localPath = isWindows
    ? join(home, ".claude", "local", "claude.exe")
    : join(home, ".claude", "local", "claude");

  if (existsSync(localPath)) {
    return localPath;
  }

  // 3. Check common global installation paths
  if (isWindows) {
    // Windows: Check npm global paths for .cmd files
    const windowsPaths = [
      join(home, "AppData", "Roaming", "npm", "claude.cmd"), // npm global (default)
      join(home, ".npm-global", "claude.cmd"), // Custom npm prefix
      join(home, "node_modules", ".bin", "claude.cmd"), // Local node_modules
    ];

    for (const path of windowsPaths) {
      if (existsSync(path)) {
        return path;
      }
    }
  } else {
    // Mac/Linux/Android paths
    const commonPaths = [
      "/usr/local/bin/claude", // Homebrew (Intel), npm global
      "/opt/homebrew/bin/claude", // Homebrew (Apple Silicon)
      join(home, ".npm-global/bin/claude"), // Custom npm global prefix
      join(home, ".local/bin/claude"), // User-local installations
      join(home, "node_modules/.bin/claude"), // Local node_modules
      // Termux (Android) paths
      "/data/data/com.termux/files/usr/bin/claude",
      join(home, "../usr/bin/claude"), // Termux relative path
    ];

    for (const path of commonPaths) {
      if (existsSync(path)) {
        return path;
      }
    }
  }

  // 4. Check global PATH using command -v (portable) / where (Windows)
  // Use shell: true to inherit user's PATH from .zshrc/.bashrc (fixes Mac detection)
  // Note: "command -v" is a shell builtin, more portable than "which" (works on Termux without extra packages)
  try {
    // On Windows use "where claude", on Unix use "command -v claude" (shell builtin, no external dependency)
    const shellCommand = isWindows ? "where claude" : "command -v claude";

    const proc = spawn(shellCommand, [], {
      stdio: "pipe",
      shell: true, // Always use shell to inherit user's PATH and run builtins
    });

    let output = "";
    proc.stdout?.on("data", (data) => {
      output += data.toString();
    });

    const exitCode = await new Promise<number>((resolve) => {
      proc.on("exit", (code) => {
        resolve(code ?? 1);
      });
    });

    if (exitCode === 0 && output.trim()) {
      const lines = output.trim().split(/\r?\n/);

      if (isWindows) {
        // On Windows, prefer .cmd file over shell script
        const cmdPath = lines.find((line) => line.endsWith(".cmd"));
        if (cmdPath) {
          return cmdPath;
        }
      }

      // Return first line (primary match)
      return lines[0];
    }
  } catch {
    // Command failed
  }

  return null;
}

/**
 * Check if Claude Code CLI is installed
 */
export async function checkClaudeInstalled(): Promise<boolean> {
  const binary = await findClaudeBinary();
  return binary !== null;
}
