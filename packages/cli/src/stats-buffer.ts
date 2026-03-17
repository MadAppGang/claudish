/**
 * Stats Disk Buffer
 *
 * Manages the on-disk event buffer at ~/.claudish/stats-buffer.json.
 * Uses in-memory cache + periodic flush to minimize disk I/O on the hot path.
 * Atomic writes via tmp file + rename to handle concurrent claudish processes.
 *
 * Size enforcement: drops oldest events when buffer exceeds 64KB.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { StatsEvent } from "./stats-otlp.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const BUFFER_MAX_BYTES = 64 * 1024; // 64KB cap
const FLUSH_EVERY_N_EVENTS = 10; // Flush to disk every N events
const FLUSH_EVERY_MS = 60_000; // Or every 60 seconds

const CLAUDISH_DIR = join(homedir(), ".claudish");
const BUFFER_FILE = join(CLAUDISH_DIR, "stats-buffer.json");

interface BufferFile {
  version: 1;
  events: StatsEvent[];
}

// ─── In-Memory Cache ──────────────────────────────────────────────────────────
// Reduces disk I/O from O(requests) to O(requests/FLUSH_EVERY_N_EVENTS).

let memoryCache: StatsEvent[] | null = null;
let eventsSinceLastFlush = 0;
let lastFlushTime = Date.now();
let flushScheduled = false;

// ─── Internal Helpers ─────────────────────────────────────────────────────────

function ensureDir(): void {
  if (!existsSync(CLAUDISH_DIR)) {
    mkdirSync(CLAUDISH_DIR, { recursive: true });
  }
}

/**
 * Read the buffer file from disk. Returns empty array on any error.
 */
function readFromDisk(): StatsEvent[] {
  try {
    if (!existsSync(BUFFER_FILE)) return [];
    const raw = readFileSync(BUFFER_FILE, "utf-8");
    const parsed = JSON.parse(raw) as BufferFile;
    if (!Array.isArray(parsed.events)) return [];
    return parsed.events;
  } catch {
    // Corrupted or missing — treat as empty
    return [];
  }
}

/**
 * Enforce the 64KB cap by dropping oldest events until under limit.
 */
function enforceSizeCap(events: StatsEvent[]): StatsEvent[] {
  // Rough size estimate using JSON length
  let payload = JSON.stringify({ version: 1, events });
  while (payload.length > BUFFER_MAX_BYTES && events.length > 0) {
    events = events.slice(1); // Drop oldest
    payload = JSON.stringify({ version: 1, events });
  }
  return events;
}

/**
 * Write events atomically to disk using tmp file + rename.
 * renameSync is atomic on POSIX systems, preventing corruption from concurrent writes.
 * Skips writing if events array is empty (no point creating an empty file).
 */
function writeToDisk(events: StatsEvent[]): void {
  try {
    if (events.length === 0) return; // No-op for empty buffer
    ensureDir();
    const trimmed = enforceSizeCap([...events]);
    const payload: BufferFile = { version: 1, events: trimmed };
    const tmpFile = join(CLAUDISH_DIR, `stats-buffer.tmp.${process.pid}.json`);
    writeFileSync(tmpFile, JSON.stringify(payload, null, 2), "utf-8");
    renameSync(tmpFile, BUFFER_FILE);
    // Update in-memory cache to reflect what was actually written (after cap)
    memoryCache = trimmed;
  } catch {
    // Disk write failure — silently ignore (stats must never crash claudish)
  }
}

/**
 * Flush the in-memory cache to disk now.
 */
function flushToDisk(): void {
  if (memoryCache === null) return;
  writeToDisk(memoryCache);
  eventsSinceLastFlush = 0;
  lastFlushTime = Date.now();
  flushScheduled = false;
}

/**
 * Schedule a deferred disk flush (if one isn't already scheduled).
 * Uses setImmediate so it runs after the current event loop tick,
 * keeping the hot path latency near zero.
 */
function scheduleFlushed(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  setImmediate(() => {
    flushToDisk();
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Append a stats event to the buffer.
 *
 * Hot path: writes to in-memory cache only. Flushes to disk:
 * - Every FLUSH_EVERY_N_EVENTS events
 * - Every FLUSH_EVERY_MS milliseconds
 * - On process exit (via process.on('exit'))
 */
export function appendEvent(event: StatsEvent): void {
  try {
    // Initialize cache from disk on first call
    if (memoryCache === null) {
      memoryCache = readFromDisk();
    }

    memoryCache.push(event);
    eventsSinceLastFlush++;

    // Always schedule a deferred flush so the event is persisted to disk even
    // for single-request invocations (common in claudish's ephemeral usage pattern).
    // The deferred flush runs after the current event-loop tick via setImmediate,
    // so it doesn't block the hot path but still happens before process exit.
    scheduleFlushed();
  } catch {
    // Never crash claudish
  }
}

/**
 * Read all buffered events.
 * Returns in-memory cache if available, otherwise reads from disk.
 */
export function readBuffer(): StatsEvent[] {
  try {
    if (memoryCache !== null) return [...memoryCache];
    return readFromDisk();
  } catch {
    return [];
  }
}

/**
 * Clear the buffer (in memory and on disk).
 */
export function clearBuffer(): void {
  try {
    memoryCache = [];
    eventsSinceLastFlush = 0;
    if (existsSync(BUFFER_FILE)) {
      unlinkSync(BUFFER_FILE);
    }
  } catch {
    // Never crash claudish
  }
}

/**
 * Flush in-memory cache to disk immediately.
 * Called before process exit and before sending to endpoint.
 */
export function flushBufferToDisk(): void {
  try {
    flushToDisk();
  } catch {
    // Never crash claudish
  }
}

/**
 * Get buffer statistics for status display.
 */
export function getBufferStats(): { events: number; bytes: number } {
  try {
    const events = readBuffer();
    const bytes = JSON.stringify({ version: 1, events }).length;
    return { events: events.length, bytes };
  } catch {
    return { events: 0, bytes: 0 };
  }
}

// ─── Process Exit Flush ───────────────────────────────────────────────────────
// Best-effort flush on process exit. Multiple signal handlers ensure we capture
// stats even when the process is killed via pipe close or terminal signals.

function syncFlushOnExit(): void {
  try {
    if (memoryCache !== null && eventsSinceLastFlush > 0) {
      writeToDisk(memoryCache);
    }
  } catch {
    // Silently ignore — process is exiting
  }
}

// Synchronous flush on normal exit
process.on("exit", syncFlushOnExit);

// Flush then exit on SIGTERM (sent by process managers, container runtimes, etc.)
process.on("SIGTERM", () => {
  try {
    syncFlushOnExit();
  } catch {
    // Silently ignore
  }
  process.exit(0);
});

// Flush then exit on SIGINT (Ctrl+C or pipe close)
process.on("SIGINT", () => {
  try {
    syncFlushOnExit();
  } catch {
    // Silently ignore
  }
  process.exit(0);
});
