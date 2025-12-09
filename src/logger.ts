import { appendFile, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

let logFilePath: string | null = null;
let logLevel: "debug" | "info" | "minimal" = "info"; // Default to structured logging
let logBuffer: string[] = []; // Buffer for async writes
let flushTimer: NodeJS.Timeout | null = null;
const FLUSH_INTERVAL_MS = 100; // Flush every 100ms
const MAX_BUFFER_SIZE = 50; // Flush if buffer exceeds 50 messages

/**
 * Debug configuration interface for component-specific debugging
 */
export interface DebugConfig {
  enabled: boolean;
  level: 'debug' | 'info' | 'minimal';
  components: {
    stream: boolean;
    process: boolean;
    sse: boolean;
    timeout: boolean;
    buffer: boolean;
    bridge: boolean;
    metrics: boolean;
  };
}

let debugConfig: DebugConfig | null = null;

/**
 * Initialize debug configuration from environment variables
 */
export function initializeDebugConfig(): DebugConfig {
  const config: DebugConfig = {
    enabled: process.env.CLAUDE_DEBUG === 'true' || process.argv.includes('--debug'),
    level: (process.env.CLAUDE_DEBUG_LEVEL as any) || 'info',
    components: {
      stream: process.env.CLAUDE_DEBUG_POE_STREAM === 'true',
      process: process.env.CLAUDE_DEBUG_POE_PROCESS === 'true',
      sse: process.env.CLAUDE_DEBUG_POE_SSE === 'true',
      timeout: process.env.CLAUDE_DEBUG_POE_TIMEOUT === 'true',
      buffer: process.env.CLAUDE_DEBUG_POE_BUFFER === 'true',
      bridge: process.env.CLAUDE_DEBUG_POE_BRIDGE === 'true',
      metrics: process.env.CLAUDE_DEBUG_POE_METRICS === 'true'
    }
  };

  // Enable all components if main debug flag is set and no specific components are enabled
  if (config.enabled && !Object.values(config.components).some(Boolean)) {
    Object.keys(config.components).forEach(key => {
      config.components[key as keyof typeof config.components] = true;
    });
  }

  debugConfig = config;
  return config;
}

/**
 * Get current debug configuration
 */
export function getDebugConfig(): DebugConfig | null {
  return debugConfig;
}

/**
 * Check if a specific debug component is enabled
 */
export function shouldDebug(component: keyof DebugConfig['components']): boolean {
  if (!debugConfig || !debugConfig.enabled) return false;
  return debugConfig.components[component];
}

/**
 * Check if logging is enabled (useful for optimizing expensive log operations)
 */
export function isLoggingEnabled(): boolean {
  return logFilePath !== null;
}

/**
 * Flush log buffer to file (async)
 */
function flushLogBuffer(): void {
  if (!logFilePath || logBuffer.length === 0) return;

  const toWrite = logBuffer.join("");
  logBuffer = [];

  // Async write (non-blocking)
  appendFile(logFilePath, toWrite, (err) => {
    if (err) {
      console.error(`[claudish] Warning: Failed to write to log file: ${err.message}`);
    }
  });
}

/**
 * Schedule periodic buffer flush
 */
function scheduleFlush(): void {
  if (flushTimer) return; // Already scheduled

  flushTimer = setInterval(() => {
    flushLogBuffer();
  }, FLUSH_INTERVAL_MS);

  // Cleanup on process exit
  process.on("exit", () => {
    if (flushTimer) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
    // Final flush (must be sync on exit)
    if (logFilePath && logBuffer.length > 0) {
      writeFileSync(logFilePath, logBuffer.join(""), { flag: "a" });
      logBuffer = [];
    }
  });
}

/**
 * Initialize file logging for this session
 */
export function initLogger(debugMode: boolean, level: "debug" | "info" | "minimal" = "info"): void {
  if (!debugMode) {
    logFilePath = null;
    // Clear any existing timer
    if (flushTimer) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
    return;
  }

  // Set log level
  logLevel = level;

  // Create logs directory if it doesn't exist
  const logsDir = join(process.cwd(), "logs");
  if (!existsSync(logsDir)) {
    mkdirSync(logsDir, { recursive: true });
  }

  // Create log file with timestamp
  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .split("T")
    .join("_")
    .slice(0, -5);
  logFilePath = join(logsDir, `claudish_${timestamp}.log`);

  // Write header (sync on init is fine)
  writeFileSync(
    logFilePath,
    `Claudish Debug Log - ${new Date().toISOString()}\nLog Level: ${level}\n${"=".repeat(80)}\n\n`
  );

  // Start periodic flush timer
  scheduleFlush();
}

/**
 * Log a message (to file only in debug mode, silent otherwise)
 * Uses async buffered writes to avoid blocking event loop
 */
export function log(message: string, forceConsole = false): void {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] ${message}\n`;

  if (logFilePath) {
    // Add to buffer (non-blocking)
    logBuffer.push(logLine);

    // Flush immediately if buffer is getting large
    if (logBuffer.length >= MAX_BUFFER_SIZE) {
      flushLogBuffer();
    }
  }

  // Force console output (for critical messages even when not in debug mode)
  if (forceConsole) {
    console.log(message);
  }
}

/**
 * Get the current log file path
 */
export function getLogFilePath(): string | null {
  return logFilePath;
}

/**
 * Mask sensitive credentials for logging
 * Shows only first 4 and last 4 characters
 */
export function maskCredential(credential: string): string {
  if (!credential || credential.length <= 8) {
    return "***";
  }
  return `${credential.substring(0, 4)}...${credential.substring(credential.length - 4)}`;
}

/**
 * Set log level (debug, info, minimal)
 * - debug: Full verbose logs (everything)
 * - info: Structured logs (communication flow, truncated content)
 * - minimal: Only critical events
 */
export function setLogLevel(level: "debug" | "info" | "minimal"): void {
  logLevel = level;
  if (logFilePath) {
    log(`[Logger] Log level changed to: ${level}`);
  }
}

/**
 * Get current log level
 */
export function getLogLevel(): "debug" | "info" | "minimal" {
  return logLevel;
}

/**
 * Truncate content for logging (keeps first N chars + "...")
 */
export function truncateContent(content: string | any, maxLength = 200): string {
  const str = typeof content === "string" ? content : JSON.stringify(content);
  if (str.length <= maxLength) {
    return str;
  }
  return `${str.substring(0, maxLength)}... [truncated ${str.length - maxLength} chars]`;
}

/**
 * Log structured data (only in info/debug mode)
 * Automatically truncates long content based on log level
 */
export function logStructured(label: string, data: Record<string, any>): void {
  if (!logFilePath) return;

  if (logLevel === "minimal") {
    // Minimal: Only show label
    log(`[${label}]`);
    return;
  }

  if (logLevel === "info") {
    // Info: Show structure with truncated content
    const structured: Record<string, any> = {};
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === "string" || typeof value === "object") {
        structured[key] = truncateContent(value, 150);
      } else {
        structured[key] = value;
      }
    }
    log(`[${label}] ${JSON.stringify(structured, null, 2)}`);
    return;
  }

  // Debug: Show everything
  log(`[${label}] ${JSON.stringify(data, null, 2)}`);
}

/**
 * Component-specific logging that checks debug configuration
 * Only logs if the specific component debug is enabled
 */
export function logComponent(
  component: keyof DebugConfig['components'],
  message: string,
  data?: Record<string, any>
): void {
  if (!shouldDebug(component)) return;

  if (data) {
    logStructured(`${component.toUpperCase()}_${message}`, data);
  } else {
    log(`[${component.toUpperCase()}] ${message}`);
  }
}

/**
 * Enhanced logging that checks both debug config and logging enabled
 * Use this for expensive debug operations to avoid unnecessary processing
 */
export function debugLog(
  component: keyof DebugConfig['components'],
  message: string,
  dataProducer?: () => Record<string, any>
): void {
  if (!shouldDebug(component) || !isLoggingEnabled()) return;

  if (dataProducer) {
    const data = dataProducer();
    logStructured(`${component.toUpperCase()}_${message}`, data);
  } else {
    log(`[${component.toUpperCase()}] ${message}`);
  }
}
