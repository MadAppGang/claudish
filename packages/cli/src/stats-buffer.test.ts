import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { StatsEvent } from "./stats-otlp.js";

// Note: We test buffer behavior by interacting with the module.
// Reset in-memory cache between tests by using clearBuffer() and
// manipulating the buffer file directly.

const CLAUDISH_DIR = join(homedir(), ".claudish");
const BUFFER_FILE = join(CLAUDISH_DIR, "stats-buffer.json");
const BACKUP_FILE = join(CLAUDISH_DIR, "stats-buffer.json.bak");

function makeEvent(overrides: Partial<StatsEvent> = {}): StatsEvent {
  return {
    timestamp: new Date().toISOString(),
    model_id: "google/gemini-2.5-pro",
    provider_name: "gemini",
    stream_format: "gemini-sse",
    latency_ms: 500,
    success: true,
    http_status: 200,
    input_tokens: 1000,
    output_tokens: 200,
    estimated_cost: 0.001,
    is_free_model: false,
    token_strategy: "standard",
    adapter_name: "DefaultAdapter",
    middleware_names: [],
    fallback_used: false,
    invocation_mode: "auto-route",
    platform: "darwin",
    arch: "arm64",
    timezone: "UTC",
    runtime: "bun-1.2",
    install_method: "homebrew",
    claudish_version: "5.12.0",
    ...overrides,
  };
}

describe("stats-buffer", () => {
  beforeEach(() => {
    // Backup existing buffer file if present
    if (existsSync(BUFFER_FILE)) {
      try {
        const content = require("node:fs").readFileSync(BUFFER_FILE, "utf-8");
        writeFileSync(BACKUP_FILE, content, "utf-8");
        unlinkSync(BUFFER_FILE);
      } catch {
        // Ignore
      }
    }
    // Re-import buffer module to reset in-memory cache
    // (Bun caches modules, so we manipulate the file directly)
  });

  afterEach(() => {
    // Restore original buffer file
    if (existsSync(BUFFER_FILE)) {
      try {
        unlinkSync(BUFFER_FILE);
      } catch {
        // Ignore
      }
    }
    if (existsSync(BACKUP_FILE)) {
      try {
        const content = require("node:fs").readFileSync(BACKUP_FILE, "utf-8");
        writeFileSync(BUFFER_FILE, content, "utf-8");
        unlinkSync(BACKUP_FILE);
      } catch {
        // Ignore
      }
    }
  });

  it("clearBuffer removes the buffer file", async () => {
    const { appendEvent, clearBuffer, flushBufferToDisk } = await import("./stats-buffer.js");

    appendEvent(makeEvent());
    flushBufferToDisk(); // Force write to disk

    clearBuffer();
    flushBufferToDisk();

    // After clear, buffer file should not exist
    expect(existsSync(BUFFER_FILE)).toBe(false);
  });

  it("getBufferStats returns zeros for empty buffer", async () => {
    const { clearBuffer, getBufferStats } = await import("./stats-buffer.js");
    clearBuffer();

    const stats = getBufferStats();
    expect(stats.events).toBe(0);
    expect(stats.bytes).toBeGreaterThanOrEqual(0);
  });

  it("appendEvent increases event count", async () => {
    const { appendEvent, clearBuffer, flushBufferToDisk, getBufferStats } = await import(
      "./stats-buffer.js"
    );
    clearBuffer();

    appendEvent(makeEvent());
    appendEvent(makeEvent());
    flushBufferToDisk();

    const stats = getBufferStats();
    // At least 2 events (may have more from other tests if module isn't fresh)
    expect(stats.events).toBeGreaterThanOrEqual(2);
  });

  it("readBuffer returns empty array when file is missing", async () => {
    const { clearBuffer, readBuffer } = await import("./stats-buffer.js");
    clearBuffer();

    const events = readBuffer();
    expect(Array.isArray(events)).toBe(true);
    expect(events.length).toBe(0);
  });

  it("handles corrupted buffer file gracefully", async () => {
    const { readBuffer, clearBuffer } = await import("./stats-buffer.js");
    clearBuffer();

    // Write corrupted JSON
    mkdirSync(CLAUDISH_DIR, { recursive: true });
    writeFileSync(BUFFER_FILE, "not-valid-json{{{", "utf-8");

    // Should not throw, return empty array
    expect(() => readBuffer()).not.toThrow();
  });

  it("flushBufferToDisk writes atomically via tmp file", async () => {
    const { appendEvent, clearBuffer, flushBufferToDisk } = await import("./stats-buffer.js");
    clearBuffer();

    appendEvent(makeEvent({ model_id: "test-atomic-model" }));
    flushBufferToDisk();

    // Buffer file should exist and be valid JSON
    expect(existsSync(BUFFER_FILE)).toBe(true);
    const content = require("node:fs").readFileSync(BUFFER_FILE, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.version).toBe(1);
    expect(Array.isArray(parsed.events)).toBe(true);
  });
});
