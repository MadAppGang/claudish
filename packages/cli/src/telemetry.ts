/**
 * Anonymous Error Telemetry Module
 *
 * Collects and reports anonymous error information to help improve claudish.
 * All telemetry is opt-in — disabled by default until the user explicitly consents.
 *
 * Privacy guarantees:
 * - No prompt content, AI responses, or tool names
 * - No API keys, credentials, or file paths
 * - No IP addresses (Firebase Hosting strips them before Cloud Function)
 * - Ephemeral session IDs (not stored, not correlatable across sessions)
 * - Error messages are sanitized before sending
 */

import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { loadConfig, saveConfig } from "./profile-config.js";
import { log } from "./logger.js";
import type { ClaudishConfig } from "./types.js";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Hardcoded telemetry endpoint. NOT user-configurable. */
const TELEMETRY_ENDPOINT = "https://claudish.com/v1/report";

/** Report size cap in bytes. Reports exceeding this are truncated. */
const MAX_REPORT_BYTES = 4096;

/**
 * Known public hostnames that should NOT be redacted from error messages.
 * These are public API endpoints whose presence in an error message is safe
 * and useful for debugging.
 */
const KNOWN_PUBLIC_HOSTS = new Set([
  "api.openai.com",
  "openrouter.ai",
  "generativelanguage.googleapis.com",
  "api.anthropic.com",
  "aip.googleapis.com",
  "api.mistral.ai",
  "api.cohere.ai",
]);

/**
 * Provider names whose model IDs are safe to include verbatim in reports.
 * Non-public providers (litellm, ollama, lmstudio) may have internal model names.
 */
const PUBLIC_PROVIDERS = new Set([
  "openrouter",
  "gemini",
  "gemini-codeassist",
  "openai",
  "vertex",
  "ollamacloud",
  "anthropic",
  "minimax",
  "kimi",
  "glm",
  "zai",
  "minimax-coding",
  "kimi-coding",
  "glm-coding",
]);

// ─── Module-Level State ───────────────────────────────────────────────────────
// Never serialized to disk. Lives only for the duration of the process.

/** Whether the user has opted in to telemetry. Loaded at initTelemetry(). */
let consentEnabled = false;

/** Ephemeral session ID. Regenerated every process invocation. Never stored. */
let sessionId = "";

/** True after initTelemetry() has been called. Guards against double-init. */
let initialized = false;

/** Claudish version, set during initTelemetry() from getVersion(). */
let claudishVersion = "";

/** Install method, detected once at initTelemetry(). */
let installMethod = "unknown";

/** Guards against multiple simultaneous consent prompts. */
let consentPromptActive = false;

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface TelemetryConsent {
  /** Explicit opt-in. Default is false (disabled until user says yes). */
  enabled: boolean;
  /**
   * ISO 8601 UTC timestamp of when the user was asked. Absent means the user
   * has never seen the consent prompt. This is the gate for re-prompting.
   */
  askedAt?: string;
  /**
   * Claudish version string when the user was first prompted. Stored for
   * future re-consent logic (e.g., if schema changes significantly).
   */
  promptedVersion?: string;
}

/**
 * Context passed from composed-handler.ts to reportError().
 * Carries the minimum information needed to build a TelemetryReport.
 * Deliberately omits: request body, response body, tool names, system prompt.
 */
export interface ErrorContext {
  /** The caught error — may be an Error object, a string, or unknown. */
  error: unknown;
  /** Provider transport name (e.g., "openrouter", "gemini"). */
  providerName: string;
  providerDisplayName: string;
  streamFormat: string;
  /** Resolved model ID passed to the provider (e.g., "google/gemini-2.0-flash"). */
  modelId: string;
  /** HTTP response status code, if the error was an HTTP error. */
  httpStatus?: number;
  /** Whether the error occurred during an active streaming response. */
  isStreaming: boolean;
  /** Whether claudish performed an automatic retry before reporting this error. */
  retryAttempted: boolean;
  /** Whether the current invocation is interactive (TTY session). Gates consent prompt. */
  isInteractive: boolean;
  // Optional contextual fields
  modelMappingRole?: "opus" | "sonnet" | "haiku" | "subagent" | "direct";
  concurrency?: number;
  adapterName?: string;
  authType?: "api-key" | "oauth" | "none";
  contextWindow?: number;
  providerErrorType?: string;
}

/**
 * The exact JSON payload sent to the telemetry endpoint.
 * All required fields must be present. Optional fields are omitted (not null)
 * when not available.
 */
export interface TelemetryReport {
  // Schema versioning
  schema_version: 1;

  // Claudish metadata
  claudish_version: string;
  install_method: string;

  // Error classification
  error_class: string;
  error_code: string;
  error_message_template: string;

  // Provider context
  provider_name: string;
  model_id: string;
  stream_format: string;

  // Request context
  http_status: number | null;
  is_streaming: boolean;
  retry_attempted: boolean;

  // Session context (non-persistent, not correlated across sessions)
  session_id: string;

  // Environment
  timestamp: string;
  platform: string;
  node_runtime: string;

  // Optional contextual fields
  model_mapping_role?: string;
  concurrency?: number;
  adapter_name?: string;
  auth_type?: string;
  context_window?: number;
  provider_error_type?: string;
}

// ─── Version Helper ───────────────────────────────────────────────────────────

/**
 * Get claudish version from packages/cli/package.json.
 * Uses createRequire for ESM compatibility. Falls back to "unknown".
 */
function getVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json") as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

// ─── Detection Helpers ────────────────────────────────────────────────────────

/**
 * Detect Node.js vs Bun runtime and major version.
 * Returns e.g., "node-22" or "bun-1.2".
 */
export function detectRuntime(): string {
  if (process.versions.bun) {
    const major = process.versions.bun.split(".").slice(0, 2).join(".");
    return `bun-${major}`;
  }
  const major = process.versions.node?.split(".")[0] ?? "unknown";
  return `node-${major}`;
}

/**
 * Detect install method by inspecting the script path.
 */
export function detectInstallMethod(): string {
  const scriptPath = process.argv[1] || "";
  if (scriptPath.includes("/.bun/")) return "bun";
  if (scriptPath.includes("/Cellar/") || scriptPath.includes("/homebrew/")) return "homebrew";
  if (
    scriptPath.includes("/node_modules/") ||
    scriptPath.includes("/.nvm/") ||
    scriptPath.includes("/npm/")
  )
    return "npm";
  return "binary";
}

// ─── Sanitization ─────────────────────────────────────────────────────────────

/**
 * Sanitize an error message string by removing PII patterns.
 * Exported for unit testing only; not part of the public API.
 *
 * Patterns removed:
 * - URL query parameters (?key=value → ?<redacted>)
 * - Home directory paths (/home/user/..., /Users/user/..., C:\Users\user\...)
 * - Tilde paths (~/...)
 * - IPv4 addresses
 * - IPv6 addresses in brackets
 * - localhost with port numbers (preserved as localhost:<port>)
 * - 127.0.0.1 with port numbers
 * - API key patterns (hex/base64 strings > 20 chars)
 *
 * Known public hostnames are preserved (not redacted).
 *
 * @param msg - Raw error message string
 * @returns Sanitized string, max 500 characters
 */
export function sanitizeMessage(msg: string): string {
  if (typeof msg !== "string") return "<non-string>";

  let s = msg;

  // 1. Strip URL query parameters (may contain auth tokens)
  s = s.replace(/\?[^\s"'`]*/g, "?<redacted>");

  // 2. Strip Unix home directory paths (entire path, not just username)
  s = s.replace(/\/(?:home|Users)\/[^\s"'`]+/g, "<path>");

  // 3. Strip Windows home directory paths (entire path, not just username)
  s = s.replace(/[A-Za-z]:\\[Uu]sers\\[^\s"'`]+/g, "<path>");

  // 4. Strip common system paths that may leak internal info
  s = s.replace(/\/(?:var|tmp|private|opt|etc)\/[^\s"'`]+/g, "<path>");

  // 5. Strip tilde paths (~/.claudish, ~/foo/bar)
  s = s.replace(/~\/[^\s]*/g, "<path>");

  // 6. Strip localhost and 127.0.0.1 with ports, then other IPv4 addresses
  s = s.replace(/localhost:(\d+)/g, "localhost:<port>");
  s = s.replace(/127\.0\.0\.1:(\d+)/g, "localhost:<port>");
  s = s.replace(/\b(?!127\.0\.0\.1)(\d{1,3}\.){3}\d{1,3}\b/g, "<host>");

  // 7. Strip IPv6 addresses in brackets
  s = s.replace(/\[[0-9a-fA-F:]{4,}\]/g, "<host>");

  // 8. Strip non-public hostnames from URLs
  s = s.replace(/https?:\/\/([a-zA-Z0-9.-]+)(:\d+)?/g, (match, host) => {
    const lowerHost = host.toLowerCase();
    for (const pub of KNOWN_PUBLIC_HOSTS) {
      if (lowerHost === pub || lowerHost.endsWith("." + pub)) {
        return match; // Keep known public hosts intact
      }
    }
    return "https://<host>";
  });

  // 9. Strip "Bearer ..." and "Authorization: ..." header values
  s = s.replace(/Bearer\s+[^\s"']+/gi, "Bearer <credential>");
  s = s.replace(/[Aa]uthorization:\s*[^\s"']+/g, "Authorization: <credential>");

  // 10. Strip JWT tokens (three base64url segments separated by dots)
  s = s.replace(/\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g, "<credential>");

  // 11. Strip sk- prefixed API keys (OpenAI, Anthropic, OpenRouter patterns)
  s = s.replace(/\bsk-[a-zA-Z0-9_\-]{10,}/g, "<credential>");

  // 12. Strip email addresses
  s = s.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "<email>");

  // 13. Strip API key patterns: hex or base64url strings longer than 20 characters.
  // NOTE: '/' is intentionally excluded from the character class — it is a URL path
  // separator and should not be matched as part of a credential. This prevents the
  // regex from clobbering URL paths that were already preserved in step 8.
  // Base64url (RFC 4648 §5) uses A-Za-z0-9 + '-' + '_' only.
  s = s.replace(/[a-zA-Z0-9+\-_]{20,}={0,2}/g, "<credential>");

  // 14. Truncate to max 500 characters
  if (s.length > 500) {
    s = s.slice(0, 497) + "...";
  }

  return s;
}

/**
 * For non-public providers (litellm, local/ollama, lmstudio), truncate the
 * model ID to just the provider prefix to avoid leaking internal model names.
 */
export function sanitizeModelId(modelId: string, providerName: string): string {
  if (PUBLIC_PROVIDERS.has(providerName)) {
    return modelId;
  }

  // For local/litellm/custom providers, redact the model name
  const atIdx = modelId.indexOf("@");
  if (atIdx !== -1) {
    return modelId.slice(0, atIdx + 1) + "<custom>";
  }
  return "<local-model>";
}

// ─── Error Classification ─────────────────────────────────────────────────────

/**
 * Classify an error into error_class and error_code.
 * Exported for unit testing only.
 */
export function classifyError(
  error: unknown,
  httpStatus?: number,
  errorText?: string
): { error_class: string; error_code: string } {
  // Connection errors (network-level, no HTTP status)
  if (error && typeof error === "object") {
    const code = (error as any).code ?? (error as any).cause?.code;
    if (code === "ECONNREFUSED") return { error_class: "connection", error_code: "econnrefused" };
    if (code === "ECONNRESET") return { error_class: "connection", error_code: "econnreset" };
    if (code === "ETIMEDOUT") return { error_class: "connection", error_code: "timeout" };
  }

  // AbortError from AbortController (fetch timeout)
  if (error instanceof Error && error.name === "AbortError") {
    return { error_class: "connection", error_code: "timeout" };
  }

  // HTTP status-based classification
  if (httpStatus !== undefined) {
    if (httpStatus === 400) {
      const lower = errorText?.toLowerCase() ?? "";
      if (lower.includes("context") || lower.includes("too long") || lower.includes("token")) {
        return { error_class: "http_error", error_code: "context_length_exceeded" };
      }
      if (
        lower.includes("unsupported content type") ||
        lower.includes("unsupported_content_type")
      ) {
        return { error_class: "http_error", error_code: "unsupported_content_type" };
      }
      return { error_class: "http_error", error_code: "bad_request_400" };
    }
    if (httpStatus === 401) return { error_class: "auth", error_code: "unauthorized_401" };
    if (httpStatus === 403) return { error_class: "auth", error_code: "forbidden_403" };
    if (httpStatus === 404) return { error_class: "http_error", error_code: "not_found_404" };
    if (httpStatus === 429) return { error_class: "rate_limit", error_code: "rate_limited_429" };
    if (httpStatus === 503)
      return { error_class: "overload", error_code: "service_unavailable_503" };
    if (httpStatus >= 500) return { error_class: "http_error", error_code: "server_error_5xx" };
    if (httpStatus >= 400)
      return { error_class: "http_error", error_code: `http_error_${httpStatus}` };
  }

  // Auth-related string patterns (for OAuth errors thrown as exceptions)
  const msg = error instanceof Error ? error.message.toLowerCase() : "";
  if (
    msg.includes("oauth") ||
    msg.includes("token expired") ||
    msg.includes("invalid token") ||
    msg.includes("refresh token") ||
    msg.includes("auth")
  ) {
    return { error_class: "auth", error_code: "oauth_refresh_failed" };
  }

  // Stream parsing errors
  if (msg.includes("json") || msg.includes("parse")) {
    return { error_class: "stream", error_code: "json_parse_error" };
  }
  if (msg.includes("stream")) {
    return { error_class: "stream", error_code: "stream_parse_error" };
  }

  // Config errors
  if (msg.includes("config") || msg.includes("missing") || msg.includes("api key")) {
    return { error_class: "config", error_code: "config_error" };
  }

  return { error_class: "unknown", error_code: "unknown_error" };
}

// ─── Report Building ──────────────────────────────────────────────────────────

/**
 * Build a TelemetryReport from an ErrorContext.
 * Exported for unit testing only.
 */
export function buildReport(ctx: ErrorContext): TelemetryReport {
  const { error_class, error_code } = classifyError(
    ctx.error,
    ctx.httpStatus,
    ctx.error instanceof Error ? ctx.error.message : String(ctx.error)
  );

  // Extract the raw error message string
  let rawMessage: string;
  if (ctx.error instanceof Error) {
    rawMessage = ctx.error.message;
  } else if (typeof ctx.error === "string") {
    rawMessage = ctx.error;
  } else {
    rawMessage = String(ctx.error);
  }

  const report: TelemetryReport = {
    schema_version: 1,

    claudish_version: claudishVersion,
    install_method: installMethod,

    error_class,
    error_code,
    error_message_template: sanitizeMessage(rawMessage),

    provider_name: ctx.providerName,
    model_id: sanitizeModelId(ctx.modelId, ctx.providerName),
    stream_format: ctx.streamFormat,

    http_status: ctx.httpStatus ?? null,
    is_streaming: ctx.isStreaming,
    retry_attempted: ctx.retryAttempted,

    session_id: sessionId,

    timestamp: new Date().toISOString(),
    platform: process.platform,
    node_runtime: detectRuntime(),
  };

  // Optional fields — only include when defined
  if (ctx.modelMappingRole !== undefined) report.model_mapping_role = ctx.modelMappingRole;
  if (ctx.concurrency !== undefined) report.concurrency = ctx.concurrency;
  if (ctx.adapterName !== undefined) report.adapter_name = ctx.adapterName;
  if (ctx.authType !== undefined) report.auth_type = ctx.authType;
  if (ctx.contextWindow !== undefined) report.context_window = ctx.contextWindow;
  if (ctx.providerErrorType !== undefined) report.provider_error_type = ctx.providerErrorType;

  return report;
}

// ─── Report Size Enforcement ──────────────────────────────────────────────────

/**
 * Serialize a report and enforce the 4KB size cap.
 * If the report exceeds MAX_REPORT_BYTES, truncate error_message_template
 * until it fits. Returns null if the report cannot be made to fit.
 */
export function enforceReportSize(report: TelemetryReport): string | null {
  let serialized = JSON.stringify(report);
  if (serialized.length <= MAX_REPORT_BYTES) return serialized;

  // Truncate error_message_template until it fits
  let msg = report.error_message_template;
  while (serialized.length > MAX_REPORT_BYTES && msg.length > 0) {
    msg = msg.slice(0, Math.max(0, msg.length - 50));
    const trimmed = { ...report, error_message_template: msg + "..." };
    serialized = JSON.stringify(trimmed);
  }

  return serialized.length <= MAX_REPORT_BYTES ? serialized : null;
}

// ─── Network Delivery ─────────────────────────────────────────────────────────

/**
 * Send a TelemetryReport to the telemetry endpoint.
 * Always called without await (fire-and-forget).
 * Silently discards all errors.
 */
async function sendReport(report: TelemetryReport): Promise<void> {
  try {
    const serialized = enforceReportSize(report);
    if (serialized === null) return; // Too large even after truncation

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    try {
      await fetch(TELEMETRY_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: serialized,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    // Silently discard all errors (network unreachable, timeout, 4xx, 5xx)
    log("[Telemetry] Failed to send report (silently discarded)");
  }
}

// ─── Consent Prompt ───────────────────────────────────────────────────────────

/**
 * Show the consent prompt in the background.
 * Uses a module-level flag to prevent multiple simultaneous prompts.
 */
function showConsentPromptAsync(ctx: ErrorContext): void {
  if (consentPromptActive) return;

  // Check config: if askedAt is already set, never prompt again
  try {
    const profileConfig = loadConfig();
    if (profileConfig.telemetry?.askedAt !== undefined) return;
  } catch {
    return; // Config read failure — skip prompt
  }

  consentPromptActive = true;

  // Run the prompt asynchronously (does not block reportError caller)
  runConsentPrompt(ctx).catch(() => {
    consentPromptActive = false;
  });
}

/**
 * Run the interactive consent prompt.
 * Saves the user's decision to ~/.claudish/config.json.
 * If accepted, sends the report that triggered the prompt.
 */
export async function runConsentPrompt(ctx: ErrorContext): Promise<void> {
  const { createInterface } = await import("node:readline");

  const errorSummary = classifyError(ctx.error, ctx.httpStatus);

  process.stderr.write("\n[claudish] An error occurred: " + errorSummary.error_code + "\n");
  process.stderr.write(
    "Help improve claudish by sending an anonymous error report?\n" +
      "  Sends: version, error type, provider, model, platform.\n" +
      "  Does NOT send: prompts, paths, API keys, or credentials.\n" +
      "  Disable anytime: claudish telemetry off\n"
  );

  const answer = await new Promise<string>((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question("Send anonymous error report? [y/N] ", (ans) => {
      rl.close();
      resolve(ans.trim().toLowerCase());
    });
  });

  const accepted = answer === "y" || answer === "yes";

  // Save consent decision to config
  try {
    const profileConfig = loadConfig();
    profileConfig.telemetry = {
      enabled: accepted,
      askedAt: new Date().toISOString(),
      promptedVersion: claudishVersion,
    };
    saveConfig(profileConfig);
    consentEnabled = accepted;
  } catch {
    // Config write failure — do not crash
  }

  if (accepted) {
    process.stderr.write("[claudish] Error reporting enabled. Thank you!\n");
    // Send the report that triggered the prompt
    try {
      const report = buildReport(ctx);
      sendReport(report); // fire-and-forget
    } catch {
      // Silently discard
    }
  } else {
    process.stderr.write(
      "[claudish] Error reporting disabled. You can enable it later: claudish telemetry on\n"
    );
  }

  consentPromptActive = false;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Initialize the telemetry module. Must be called once at process startup,
 * after parseArgs() has run (so ClaudishConfig is available).
 *
 * Reads consent state from ~/.claudish/config.json.
 * Generates an ephemeral session_id using crypto.randomBytes.
 * Detects install method and node runtime.
 *
 * This function is synchronous and fast (< 1ms). It does not make any
 * network calls.
 *
 * @param config - The parsed CLI config. Used to read the interactive flag.
 */
export function initTelemetry(config: ClaudishConfig): void {
  if (initialized) return;
  initialized = true;

  // Check environment variable override (CI/scripts)
  const envOverride = process.env.CLAUDISH_TELEMETRY;
  if (envOverride === "0" || envOverride === "false" || envOverride === "off") {
    consentEnabled = false;
    return;
  }

  // Read consent from ~/.claudish/config.json
  try {
    const profileConfig = loadConfig();
    consentEnabled = profileConfig.telemetry?.enabled ?? false;
  } catch {
    // Config read failure — default to disabled, do not throw
    consentEnabled = false;
  }

  // Generate ephemeral session ID (never stored to disk)
  sessionId = randomBytes(8).toString("hex");

  // Cache version and install method for report construction
  claudishVersion = getVersion();
  installMethod = detectInstallMethod();
}

/**
 * Report an error to the telemetry backend. Non-blocking: returns void
 * immediately. The HTTP send (if it happens) runs asynchronously after
 * this function returns.
 *
 * NEVER throws. NEVER awaited by caller. Safe to call from any context.
 *
 * @param ctx - Error context from the call site
 */
export function reportError(ctx: ErrorContext): void {
  // Fast exit: telemetry not initialized or disabled
  if (!initialized || !consentEnabled) {
    // Check if we should show the consent prompt (first-time, interactive only)
    if (initialized && !consentEnabled && ctx.isInteractive && process.stderr.isTTY) {
      // Show consent prompt asynchronously — does not block the caller
      showConsentPromptAsync(ctx);
    }
    return;
  }

  // Check environment variable override at call time too
  const envOverride = process.env.CLAUDISH_TELEMETRY;
  if (envOverride === "0" || envOverride === "false" || envOverride === "off") {
    return;
  }

  // Build and send the report (fire-and-forget)
  try {
    const report = buildReport(ctx);
    sendReport(report); // NOT awaited — intentional fire-and-forget
  } catch {
    // buildReport() should not throw, but guard anyway
    log("[Telemetry] Error building report (silently discarded)");
  }
}

/**
 * Handle `claudish telemetry <subcommand>` commands.
 * Subcommands: "on" | "off" | "status" | "reset"
 *
 * All output goes to stderr. Exits with process.exit(0) on success,
 * process.exit(1) on unknown subcommand.
 *
 * @param subcommand - The telemetry subcommand string
 */
export async function handleTelemetryCommand(subcommand: string): Promise<void> {
  switch (subcommand) {
    case "on": {
      const cfg = loadConfig();
      cfg.telemetry = {
        ...(cfg.telemetry ?? {}),
        enabled: true,
        askedAt: cfg.telemetry?.askedAt ?? new Date().toISOString(),
        promptedVersion: claudishVersion || getVersion(),
      };
      saveConfig(cfg);
      process.stderr.write("[claudish] Telemetry enabled. Anonymous error reports will be sent.\n");
      process.exit(0);
    }

    case "off": {
      const cfg = loadConfig();
      cfg.telemetry = {
        ...(cfg.telemetry ?? {}),
        enabled: false,
        askedAt: cfg.telemetry?.askedAt ?? new Date().toISOString(),
      };
      saveConfig(cfg);
      process.stderr.write("[claudish] Telemetry disabled. No error reports will be sent.\n");
      process.exit(0);
    }

    case "status": {
      const cfg = loadConfig();
      const t = cfg.telemetry;
      const envOverride = process.env.CLAUDISH_TELEMETRY;
      const envDisabled = envOverride === "0" || envOverride === "false" || envOverride === "off";

      if (envDisabled) {
        process.stderr.write(
          "[claudish] Telemetry: DISABLED (CLAUDISH_TELEMETRY env var override)\n"
        );
      } else if (!t) {
        process.stderr.write(
          "[claudish] Telemetry: NOT YET CONFIGURED (will prompt on first error)\n"
        );
      } else {
        const state = t.enabled ? "ENABLED" : "DISABLED";
        const asked = t.askedAt ? `(configured ${t.askedAt})` : "(never prompted)";
        process.stderr.write(`[claudish] Telemetry: ${state} ${asked}\n`);
      }

      process.stderr.write("\nData collected when enabled:\n");
      process.stderr.write("  - Claudish version, error type, provider name, model ID\n");
      process.stderr.write("  - Platform (darwin/linux/win32), runtime, install method\n");
      process.stderr.write("  - Sanitized error message (no paths, no credentials)\n");
      process.stderr.write("  - Ephemeral session ID (not stored, not correlatable)\n");
      process.stderr.write("\nData NEVER collected:\n");
      process.stderr.write("  - Prompt content, AI responses, tool names\n");
      process.stderr.write("  - API keys, credentials, file paths, hostnames\n");
      process.stderr.write("  - Your name, email, or IP address\n");
      process.stderr.write("\nManage: claudish telemetry on|off|reset\n");
      process.exit(0);
    }

    case "reset": {
      const cfg = loadConfig();
      if (cfg.telemetry) {
        delete cfg.telemetry.askedAt;
        cfg.telemetry.enabled = false;
        saveConfig(cfg);
      }
      process.stderr.write(
        "[claudish] Telemetry consent reset. You will be asked again on the next error.\n"
      );
      process.exit(0);
    }

    default:
      process.stderr.write(
        `[claudish] Unknown telemetry subcommand: "${subcommand}"\n` +
          "Usage: claudish telemetry on|off|status|reset\n"
      );
      process.exit(1);
  }
}
