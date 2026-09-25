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
  let kept = events;
  let payload = JSON.stringify({ version: 1, events: kept });
  while (payload.length > BUFFER_MAX_BYTES && kept.length > 0) {
    kept = kept.slice(1); // Drop oldest
    payload = JSON.stringify({ version: 1, events: kept });
  }
  return kept;
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

/**
 * `128 + signum`, the shell convention for "died from signal N".
 *
 * These two handlers are registered at MODULE LOAD, before any command's own,
 * and they call `process.exit` unconditionally, so a SIGTERM reaches them first
 * unless a command that must stop something before the process goes takes them
 * off with `releaseSignalHandlers` (the runner does, once Claude Code is
 * running). While they exited 0, a claudish process that a
 * supervisor had KILLED reported a clean success to everything above it:
 * measured 2026-08-22, a group SIGTERM against a running channel session still
 * produced `code=0, signal=null` with `claude-runner.ts` already fixed.
 *
 * That mattered most in the channel session manager, where an exit-0 was
 * allowed to upgrade a state the timeout handler had already recorded as
 * failed, and `meta.json` was written saying `"completed"` for a session that
 * had been killed 15 minutes into real, billed work.
 *
 * Telemetry flushing must not editorialise about how the process died.
 */
const SIGNAL_EXIT_CODE: Record<"SIGTERM" | "SIGINT", number> = { SIGTERM: 143, SIGINT: 130 };

const signalHandlers: Array<[NodeJS.Signals, () => void]> = [];
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  const handler = () => {
    try {
      syncFlushOnExit();
    } catch {
      // Silently ignore
    }
    process.exit(SIGNAL_EXIT_CODE[signal]);
  };
  process.on(signal, handler);
  signalHandlers.push([signal, handler]);
}

/**
 * Take the two handlers above off their signals, for a command that must finish its
 * own shutdown before the process goes, such as one stopping a child that still
 * depends on it. Stats still flush on `exit`, and the caller owes the `128 + signum`
 * exit these handlers give.
 */
export function releaseSignalHandlers(): void {
  for (const [signal, handler] of signalHandlers) {
    process.off(signal, handler);
  }
}
