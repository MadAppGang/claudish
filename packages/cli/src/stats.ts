/**
 * Anonymous Usage Stats Module
 *
 * Collects and batches anonymous LLM request statistics to help improve
 * claudish provider routing and model recommendations.
 *
 * Privacy guarantees:
 * - No prompts, AI responses, tool names, or file paths
 * - No API keys or credentials
 * - No raw IP addresses (backend hashes to coarse region, discards IP)
 * - Local model names sanitized to <local-model>
 *
 * Stats are OFF by default — user must explicitly run `claudish stats on`.
 *
 * Env var override: CLAUDISH_STATS=0|false|off disables all collection.
 */

import { createRequire } from "node:module";
import { loadConfig, saveConfig } from "./profile-config.js";
import { detectRuntime, detectInstallMethod, sanitizeModelId } from "./telemetry.js";
import { parseModelSpec } from "./providers/model-parser.js";
import {
  appendEvent,
  readBuffer,
  clearBuffer,
  getBufferStats,
  flushBufferToDisk,
} from "./stats-buffer.js";
import { formatOtlpBatch, type StatsEvent, type OtlpResource } from "./stats-otlp.js";
import type { ClaudishConfig } from "./types.js";

export type { StatsEvent } from "./stats-otlp.js";
export type { StatsConsent } from "./stats-otlp.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const STATS_ENDPOINT = "https://claudish.com/v1/stats";
const FLUSH_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MONTHLY_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SEND_TIMEOUT_MS = 5000; // 5 second timeout

// ─── Module-Level State ───────────────────────────────────────────────────────

/** Whether the user has opted in to stats. Loaded at initStats(). */
let statsEnabled = false;

/** True after initStats() has been called. Guards against double-init. */
let initialized = false;

/** Claudish version, set during initStats(). */
let claudishVersion = "";

/** Install method, detected once at initStats(). */
let installMethod = "unknown";

/** Environment attributes, set once at init time. */
let envAttributes: {
  platform: string;
  arch: string;
  timezone: string;
  runtime: string;
} = {
  platform: "unknown",
  arch: "unknown",
  timezone: "UTC",
  runtime: "unknown",
};

// ─── Version Helper ───────────────────────────────────────────────────────────

function getVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json") as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

// ─── Environment Detection ────────────────────────────────────────────────────

function detectTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  } catch {
    return "UTC";
  }
}

function isStatsDisabledByEnv(): boolean {
  const v = process.env.CLAUDISH_STATS;
  return v === "0" || v === "false" || v === "off";
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Initialize the stats module. Called once at process startup after config loads.
 * Synchronous and fast (< 1ms). No network calls.
 */
export function initStats(config: ClaudishConfig): void {
  try {
    if (initialized) return;
    initialized = true;

    // Check environment variable override
    if (isStatsDisabledByEnv()) {
      statsEnabled = false;
      return;
    }

    // Read consent from config
    try {
      const profileConfig = loadConfig();
      statsEnabled = profileConfig.stats?.enabled ?? false;
    } catch {
      statsEnabled = false;
    }

    // Cache version and environment attributes
    claudishVersion = getVersion();
    installMethod = detectInstallMethod();
    envAttributes = {
      platform: process.platform,
      arch: process.arch,
      timezone: detectTimezone(),
      runtime: detectRuntime(),
    };
  } catch {
    // Never crash claudish
    statsEnabled = false;
  }
}

/**
 * Record a stats event. Fast exit if disabled.
 * Buffers to memory via appendEvent() — non-blocking.
 * Triggers background flush if 24h have elapsed since last send.
 */
export function recordStats(partial: Partial<StatsEvent>): void {
  try {
    if (!initialized || !statsEnabled) return;
    if (isStatsDisabledByEnv()) return;

    // Build the full event with defaults
    const event: StatsEvent = {
      timestamp: new Date().toISOString(),
      model_id: partial.model_id ?? "unknown",
      provider_name: partial.provider_name ?? "unknown",
      stream_format: partial.stream_format ?? "unknown",
      latency_ms: partial.latency_ms ?? 0,
      success: partial.success ?? true,
      http_status: partial.http_status ?? 200,
      input_tokens: partial.input_tokens ?? 0,
      output_tokens: partial.output_tokens ?? 0,
      estimated_cost: partial.estimated_cost ?? 0,
      is_free_model: partial.is_free_model ?? false,
      token_strategy: partial.token_strategy ?? "standard",
      adapter_name: partial.adapter_name ?? "DefaultAdapter",
      middleware_names: partial.middleware_names ?? [],
      fallback_used: partial.fallback_used ?? false,
      invocation_mode: partial.invocation_mode ?? "auto-route",
      // Environment attributes (set at init, same for all events in session)
      platform: envAttributes.platform,
      arch: envAttributes.arch,
      timezone: envAttributes.timezone,
      runtime: envAttributes.runtime,
      install_method: installMethod,
      claudish_version: claudishVersion,
    };

    // Strip provider prefix (e.g. "g@gemini-2.5-flash" → "gemini-2.5-flash")
    // parseModelSpec handles all prefix/shortcut forms safely.
    try {
      event.model_id = parseModelSpec(event.model_id).model;
    } catch {
      // If parsing fails, keep original
    }

    // Sanitize model ID (redacts local/custom model names)
    event.model_id = sanitizeModelId(event.model_id, event.provider_name);

    // Optional fields
    if (partial.error_class !== undefined) event.error_class = partial.error_class;
    if (partial.error_code !== undefined) event.error_code = partial.error_code;
    if (partial.fallback_chain !== undefined) event.fallback_chain = partial.fallback_chain;
    if (partial.fallback_attempts !== undefined)
      event.fallback_attempts = partial.fallback_attempts;

    appendEvent(event);

    // Check if it's time for a flush (24h interval) — run in background
    checkAndFlush();
  } catch {
    // Never crash claudish
  }
}

/**
 * Check if 24h have elapsed since last send. If so, trigger a background flush.
 */
function checkAndFlush(): void {
  try {
    const profileConfig = loadConfig();
    const lastSentAt = profileConfig.stats?.lastSentAt;
    if (!lastSentAt) {
      // Never sent — flush after first event accumulates
      setTimeout(() => {
        flushStats().catch(() => {});
      }, 0);
      return;
    }
    const elapsed = Date.now() - new Date(lastSentAt).getTime();
    if (elapsed >= FLUSH_INTERVAL_MS) {
      setTimeout(() => {
        flushStats().catch(() => {});
      }, 0);
    }
  } catch {
    // Never crash claudish
  }
}

/**
 * Flush buffered events to the stats endpoint.
 * Reads buffer → formats as OTLP JSON → POST to endpoint → clears on success.
 * Called in background; never awaited by request path.
 */
export async function flushStats(): Promise<void> {
  try {
    if (isStatsDisabledByEnv()) return;

    // Flush in-memory cache to disk first
    flushBufferToDisk();

    const events = readBuffer();
    if (events.length === 0) return;

    const resource: OtlpResource = {
      version: claudishVersion,
      platform: envAttributes.platform,
      arch: envAttributes.arch,
      runtime: envAttributes.runtime,
      installMethod: installMethod,
      timezone: envAttributes.timezone,
    };

    const body = formatOtlpBatch(events, resource);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);

    try {
      const response = await fetch(STATS_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: controller.signal,
      });

      if (response.ok) {
        // Clear buffer on success
        clearBuffer();

        // Update lastSentAt in config
        try {
          const profileConfig = loadConfig();
          if (!profileConfig.stats) {
            profileConfig.stats = { enabled: statsEnabled };
          }
          profileConfig.stats.lastSentAt = new Date().toISOString();
          saveConfig(profileConfig);
        } catch {
          // Config write failure — do not crash
        }
      }
      // On non-2xx: keep events in buffer for next attempt
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    // Network error, timeout, etc. — events preserved in buffer for next attempt
  }
}

/**
 * Check if the monthly banner should be shown and show it.
 * Uses 30-day intervals (not calendar months) to avoid edge cases.
 *
 * Shows:
 * - First run (never prompted): opt-in nudge
 * - Monthly — enabled: thank-you
 * - Monthly — disabled: re-engagement nudge
 */
export function showMonthlyBanner(): void {
  try {
    if (isStatsDisabledByEnv()) return;

    const profileConfig = loadConfig();
    const consent = profileConfig.stats;

    const now = Date.now();
    const lastPrompt = consent?.lastMonthlyPrompt
      ? new Date(consent.lastMonthlyPrompt).getTime()
      : 0;
    const timeSincePrompt = now - lastPrompt;

    const isFirstRun = !consent?.lastMonthlyPrompt;
    const isMonthlyInterval = timeSincePrompt >= MONTHLY_INTERVAL_MS;

    if (!isFirstRun && !isMonthlyInterval) return;

    // Show banner to stderr
    if (isFirstRun) {
      process.stderr.write(
        "[claudish] Help improve claudish! Enable anonymous usage stats for better provider recommendations.\n" +
          "           No prompts, API keys, or personal data — just model, latency, and token counts.\n" +
          "           Enable: claudish stats on | Docs: claudish stats status\n"
      );
    } else if (consent?.enabled) {
      process.stderr.write(
        "[claudish] Usage stats are ON — thank you for helping improve claudish!\n"
      );
    } else {
      process.stderr.write(
        "[claudish] We'd appreciate your anonymous usage stats to improve provider recommendations.\n" +
          "           Claudish is free and open source — your data helps us serve everyone better.\n" +
          "           Enable: claudish stats on\n"
      );
    }

    // Update lastMonthlyPrompt
    try {
      const cfg = loadConfig();
      if (!cfg.stats) {
        cfg.stats = { enabled: false };
      }
      cfg.stats.lastMonthlyPrompt = new Date().toISOString();
      if (!cfg.stats.promptedVersion) {
        cfg.stats.promptedVersion = claudishVersion || getVersion();
      }
      saveConfig(cfg);
    } catch {
      // Config write failure — do not crash
    }
  } catch {
    // Never crash claudish
  }
}

/**
 * Handle `claudish stats <subcommand>` commands.
 * Subcommands: "on" | "off" | "status" | "reset"
 */
export async function handleStatsCommand(subcommand: string): Promise<void> {
  const version = claudishVersion || getVersion();

  switch (subcommand) {
    case "on": {
      const cfg = loadConfig();
      if (!cfg.stats) cfg.stats = { enabled: false };
      cfg.stats.enabled = true;
      cfg.stats.enabledAt = cfg.stats.enabledAt ?? new Date().toISOString();
      cfg.stats.promptedVersion = cfg.stats.promptedVersion ?? version;
      saveConfig(cfg);
      process.stderr.write(
        "[claudish] Usage stats enabled. Anonymous provider performance data will be sent daily.\n"
      );
      process.exit(0);
    }

    case "off": {
      const cfg = loadConfig();
      if (!cfg.stats) cfg.stats = { enabled: false };
      cfg.stats.enabled = false;
      saveConfig(cfg);
      process.stderr.write("[claudish] Usage stats disabled. No data will be sent.\n");
      process.exit(0);
    }

    case "status": {
      const cfg = loadConfig();
      const s = cfg.stats;
      const envOverride = process.env.CLAUDISH_STATS;
      const envDisabled = envOverride === "0" || envOverride === "false" || envOverride === "off";

      if (envDisabled) {
        process.stderr.write(
          "[claudish] Usage Stats: DISABLED (CLAUDISH_STATS env var override)\n"
        );
      } else if (!s) {
        process.stderr.write("[claudish] Usage Stats: NOT YET CONFIGURED\n");
      } else {
        const state = s.enabled ? "ENABLED" : "DISABLED";
        const when = s.enabledAt ? `(configured ${s.enabledAt})` : "";
        process.stderr.write(`[claudish] Usage Stats: ${state} ${when}\n`);
      }

      const { events, bytes } = getBufferStats();
      const kb = (bytes / 1024).toFixed(1);
      process.stderr.write(`\nBuffer: ${events} events (${kb} KB)\n`);

      const lastSent = s?.lastSentAt ?? "never";
      process.stderr.write(`Last sent: ${lastSent}\n`);

      process.stderr.write("\nData collected when enabled:\n");
      process.stderr.write(
        "  - Model ID, provider name, latency, HTTP status\n" +
          "  - Token counts, estimated cost, stream format\n" +
          "  - Adapter/middleware names (no details), fallback info\n" +
          "  - Platform, architecture, timezone, runtime, version\n"
      );
      process.stderr.write("\nData NEVER collected:\n");
      process.stderr.write("  - Prompts, AI responses, API keys, file paths, IP addresses\n");
      process.stderr.write("\nFormat: OpenTelemetry Protocol (OTLP) Logs\n");
      process.stderr.write("Manage: claudish stats on|off|reset\n");
      process.exit(0);
    }

    case "reset": {
      const cfg = loadConfig();
      if (cfg.stats) {
        cfg.stats = { enabled: false };
      }
      clearBuffer();
      saveConfig(cfg);
      process.stderr.write(
        "[claudish] Stats consent reset and buffer cleared. You will see the opt-in banner on next run.\n"
      );
      process.exit(0);
    }

    default:
      process.stderr.write(
        `[claudish] Unknown stats subcommand: "${subcommand}"\n` +
          "Usage: claudish stats on|off|status|reset\n"
      );
      process.exit(1);
  }
}

// ─── Process Exit Flush ───────────────────────────────────────────────────────
// Best-effort flush on process exit.

process.on("beforeExit", () => {
  try {
    if (statsEnabled && !isStatsDisabledByEnv()) {
      flushStats().catch(() => {});
    }
  } catch {
    // Silently ignore
  }
});
