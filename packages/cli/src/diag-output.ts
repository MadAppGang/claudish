import { createWriteStream, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import type { WriteStream } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * DiagOutput separates claudish diagnostic messages from Claude Code's TUI.
 * Instead of writing to stderr (which corrupts the TUI), diagnostic messages
 * are routed to a log file.
 */
export interface DiagOutput {
  write(msg: string): void;
  cleanup(): void;
}

/**
 * Get the path to the claudish directory, creating it if needed.
 */
function getClaudishDir(): string {
  const dir = join(homedir(), ".claudish");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // Already exists
  }
  return dir;
}

/**
 * Get a session-unique diag log file path.
 * Uses PID to avoid conflicts when multiple claudish sessions run simultaneously.
 */
function getDiagLogPath(): string {
  return join(getClaudishDir(), `diag-${process.pid}.log`);
}

/**
 * LogFileDiagOutput writes diagnostic messages to ~/.claudish/diag-<PID>.log.
 * Truncates the log on session start (overwrite mode). Includes timestamps.
 */
export class LogFileDiagOutput implements DiagOutput {
  protected logPath: string;
  protected stream: WriteStream;

  constructor() {
    this.logPath = getDiagLogPath();

    // Write session header (truncates previous session)
    try {
      writeFileSync(this.logPath, `--- claudish diag session ${new Date().toISOString()} ---\n`);
    } catch {
      // If write fails, we'll still try the stream
    }

    // Open append stream for subsequent writes
    this.stream = createWriteStream(this.logPath, { flags: "a" });
    this.stream.on("error", () => {}); // Best-effort — never crash on write errors
  }

  write(msg: string): void {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${msg}\n`;
    try {
      this.stream.write(line);
    } catch {
      // Ignore write errors — diag output is best-effort
    }
  }

  cleanup(): void {
    try {
      this.stream.end();
    } catch {
      // Ignore
    }
    // Remove session-specific diag file (ephemeral, not needed after exit)
    try {
      unlinkSync(this.logPath);
    } catch {
      // Ignore — file may already be gone
    }
  }

  getLogPath(): string {
    return this.logPath;
  }
}

/**
 * NullDiagOutput is a no-op. Used in single-shot mode where stderr is
 * available normally (Claude Code not running as TUI).
 */
export class NullDiagOutput implements DiagOutput {
  write(_msg: string): void {
    // no-op
  }

  cleanup(): void {
    // no-op
  }
}

/**
 * Factory: create the appropriate DiagOutput based on config and environment.
 *
 * diagMode controls which implementation is used:
 *   "auto" (default) → log file (silent, no visible pane)
 *   "logfile"        → log file only (explicit)
 *   "off"            → no diagnostics at all
 */
export function createDiagOutput(options: {
  interactive: boolean;
  diagMode?: "auto" | "logfile" | "off";
}): DiagOutput {
  if (!options.interactive) {
    return new NullDiagOutput();
  }

  const mode = options.diagMode || "auto";

  if (mode === "off") {
    return new NullDiagOutput();
  }

  return new LogFileDiagOutput();
}
