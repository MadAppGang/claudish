import { appendFile, existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DiagOutput } from "./diag-output.js";

let logFilePath: string | null = null;
let logLevel: "debug" | "info" | "minimal" = "info"; // Default to structured logging
let stderrQuiet = false; // When true, logStderr writes to log file only (no terminal output)
let diagOutput: DiagOutput | null = null; // DiagOutput instance for routing stderr in interactive mode
let logBuffer: string[] = []; // Buffer for async writes
let flushTimer: NodeJS.Timeout | null = null;
const FLUSH_INTERVAL_MS = 100; // Flush every 100ms
const MAX_BUFFER_SIZE = 50; // Flush if buffer exceeds 50 messages

// Tier 1: Always-on structural logging state
let alwaysOnLogPath: string | null = null;
let alwaysOnBuffer: string[] = [];

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
 * Flush always-on structural log buffer to file (async)
 */
function flushAlwaysOnBuffer(): void {
  if (!alwaysOnLogPath || alwaysOnBuffer.length === 0) return;
  const toWrite = alwaysOnBuffer.join("");
  alwaysOnBuffer = [];
  appendFile(alwaysOnLogPath, toWrite, () => {});
}

/**
 * Schedule periodic buffer flush
 */
function scheduleFlush(): void {
  if (flushTimer) return; // Already scheduled

  flushTimer = setInterval(() => {
    flushLogBuffer();
    flushAlwaysOnBuffer();
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
    if (alwaysOnLogPath && alwaysOnBuffer.length > 0) {
      writeFileSync(alwaysOnLogPath, alwaysOnBuffer.join(""), { flag: "a" });
      alwaysOnBuffer = [];
    }
  });
}

/**
 * Keep only the most recent N log files, delete older ones.
 */
function rotateOldLogs(dir: string, keep: number): void {
  try {
    const files = readdirSync(dir)
      .filter((f) => f.startsWith("claudish_") && f.endsWith(".log"))
      .sort()
      .reverse();
    for (const file of files.slice(keep)) {
      try {
        unlinkSync(join(dir, file));
      } catch {}
    }
  } catch {}
}

/**
 * Strip content from a JSON SSE line, preserving structure.
 * Replaces string values longer than 20 chars with "<N chars>".
 * Preserves: keys, numbers, booleans, nulls, short strings (model names, event types, finish reasons).
 */
export function structuralRedact(jsonStr: string): string {
  try {
    const obj = JSON.parse(jsonStr);
    return JSON.stringify(redactDeep(obj));
  } catch {
    // Not valid JSON — redact long strings inline
    return jsonStr.replace(/"[^"]{20,}"/g, (m) => `"<${m.length - 2} chars>"`);
  }
}

/** Keys that always carry model/user content — redact regardless of length */
const CONTENT_KEYS = new Set([
  "content",
  "reasoning_content",
  "text",
  "thinking",
  "partial_json",
  "arguments",
  "input",
]);

function redactDeep(val: any, key?: string): any {
  if (val === null || val === undefined) return val;
  if (typeof val === "boolean" || typeof val === "number") return val;
  if (typeof val === "string") {
    // Content keys: always redact (these carry model/user text)
    if (key && CONTENT_KEYS.has(key)) {
      return `<${val.length} chars>`;
    }
    // Other strings: keep short ones (model names, event types, tool names, finish reasons)
    return val.length <= 20 ? val : `<${val.length} chars>`;
  }
  if (Array.isArray(val)) return val.map((v) => redactDeep(v));
  if (typeof val === "object") {
    const result: any = {};
    for (const [k, v] of Object.entries(val)) {
      result[k] = redactDeep(v, k);
    }
    return result;
  }
  return val;
}

/**
 * Determine if a log message should be written to the always-on structural log.
 * Only structural/diagnostic messages, not verbose debug noise.
 */
function isStructuralLogWorthy(msg: string): boolean {
  return (
    msg.startsWith("[SSE:") ||
    // Output the terminal firewall kept off the TTY. This is the ONLY durable
    // record of it: the diag file is unlinked on session cleanup, so without
    // this entry a suppressed dependency crash would vanish entirely. Matched
    // explicitly rather than relying on the generic "error" substring below —
    // a suppressed stdout line need not contain the word.
    msg.startsWith("[Suppressed]") ||
    msg.startsWith("[Proxy]") ||
    // How the spawned Claude Code process ended: its exit code, or the signal
    // that killed it. The [Proxy] lines above cannot record a child that died
    // before its first request, which is exactly the session whose log looks
    // empty and whose failure the user most needs named.
    msg.startsWith("[Claude Code]") ||
    msg.startsWith("[Fallback]") ||
    msg.startsWith("[Streaming] ===") || // HANDLER STARTED
    msg.startsWith("[Streaming] Chunk:") ||
    msg.startsWith("[Streaming] Received") ||
    msg.startsWith("[Streaming] Text-based tool calls") ||
    msg.startsWith("[Streaming] Final usage") ||
    msg.startsWith("[Streaming] Sending") ||
    msg.startsWith("[AnthropicSSE] Stream complete") ||
    msg.startsWith("[AnthropicSSE] Tool use:") ||
    msg.includes("Response status:") ||
    msg.includes("Error") ||
    msg.includes("error") ||
    msg.includes("[Auto-route]")
  );
}

/**
 * Redact content from a log line for structural logging.
 * SSE lines get JSON structural redaction. Other lines pass through.
 */
function redactLogLine(message: string, timestamp: string): string {
  // SSE raw events: redact the JSON payload
  if (message.startsWith("[SSE:")) {
    const prefixEnd = message.indexOf("] ") + 2;
    const prefix = message.substring(0, prefixEnd);
    const payload = message.substring(prefixEnd);
    return `[${timestamp}] ${prefix}${structuralRedact(payload)}\n`;
  }
  // Other lines: pass through (they don't contain user content)
  return `[${timestamp}] ${message}\n`;
}

/**
 * Initialize file logging for this session
 */
export function initLogger(
  debugMode: boolean,
  level: "debug" | "info" | "minimal" = "info",
  noLogs = false
): void {
  // Tier 1: Always-on structural logging (unless --log-off)
  if (!noLogs) {
    const logsDir = join(homedir(), ".claudish", "logs");
    if (!existsSync(logsDir)) {
      mkdirSync(logsDir, { recursive: true });
    }
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .split("T")
      .join("_")
      .slice(0, -5);
    alwaysOnLogPath = join(logsDir, `claudish_${timestamp}.log`);
    writeFileSync(
      alwaysOnLogPath,
      `Claudish Session Log - ${new Date().toISOString()}\nMode: structural (content redacted)\n${"=".repeat(60)}\n\n`
    );
    rotateOldLogs(logsDir, 20);
    // Start flush timer if not already running
    scheduleFlush();
  }

  // Tier 2: Debug verbose logging (existing behavior, only with --debug-claudish)
  if (debugMode) {
    logLevel = level;
    const logsDir = join(process.cwd(), "logs");
    if (!existsSync(logsDir)) {
      mkdirSync(logsDir, { recursive: true });
    }
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .split("T")
      .join("_")
      .slice(0, -5);
    logFilePath = join(logsDir, `claudish_${timestamp}.log`);
    writeFileSync(
      logFilePath,
      `Claudish Debug Log - ${new Date().toISOString()}\nLog Level: ${level}\n${"=".repeat(80)}\n\n`
    );
    scheduleFlush();
  } else {
    logFilePath = null;
    // Clear any existing timer only if always-on is also disabled
    if (noLogs && flushTimer) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
  }
}

/**
 * Log a message (to file only in debug mode, silent otherwise)
 * Uses async buffered writes to avoid blocking event loop
 */
export function log(message: string, forceConsole = false): void {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] ${message}\n`;

  // Tier 2: Debug log (full content, existing behavior)
  if (logFilePath) {
    // Add to buffer (non-blocking)
    logBuffer.push(logLine);

    // Flush immediately if buffer is getting large
    if (logBuffer.length >= MAX_BUFFER_SIZE) {
      flushLogBuffer();
    }
  }

  // Tier 1: Always-on structural log (redacted content)
  if (alwaysOnLogPath && isStructuralLogWorthy(message)) {
    const redactedLine = redactLogLine(message, timestamp);
    alwaysOnBuffer.push(redactedLine);
    if (alwaysOnBuffer.length >= MAX_BUFFER_SIZE) {
      flushAlwaysOnBuffer();
    }
  }

  // Force console output (for critical messages even when not in debug mode)
  if (forceConsole) {
    console.log(message);
  }
}

/**
 * Log a message to stderr and to the debug log file.
 * In quiet mode (interactive Claude Code sessions), only writes to log file
 * to avoid corrupting Claude Code's TUI display.
 * When a DiagOutput is set, stderr messages are routed there instead.
 */
export function logStderr(message: string): void {
  if (diagOutput) {
    // Route to DiagOutput (log file) instead of polluting stderr
    diagOutput.write(message);
  } else if (!stderrQuiet) {
    process.stderr.write(`[claudish] ${message}\n`);
  }
  log(message); // always write to debug log
}

/**
 * Set the DiagOutput instance. When set, logStderr() routes to it
 * instead of stderr. This replaces the stderrQuiet mechanism for
 * interactive sessions.
 */
export function setDiagOutput(output: DiagOutput | null): void {
  diagOutput = output;
}

/**
 * Suppress stderr output (for interactive Claude Code sessions where
 * stderr corrupts the TUI). Log file output is preserved.
 * Kept for backwards compatibility — prefer setDiagOutput() for new code.
 */
export function setStderrQuiet(quiet: boolean): void {
  stderrQuiet = quiet;
}

/**
 * Get the current log file path
 */
export function getLogFilePath(): string | null {
  return logFilePath;
}

/**
 * Get the always-on structural log file path
 */
export function getAlwaysOnLogPath(): string | null {
  return alwaysOnLogPath;
}

/**
 * Check if logging is enabled (useful for optimizing expensive log operations)
 */
export function isLoggingEnabled(): boolean {
  return logFilePath !== null || alwaysOnLogPath !== null;
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
  if (content === undefined || content === null) return "[empty]";
  const str = typeof content === "string" ? content : (JSON.stringify(content) ?? "[empty]");
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
