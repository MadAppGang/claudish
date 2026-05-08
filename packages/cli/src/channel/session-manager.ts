// ─── SessionManager ──────────────────────────────────────────────────────────
//
// Manages the lifecycle of channel sessions. Each session spawns a claudish
// child process with piped stdio, tracks its output via ScrollbackBuffer,
// and detects state transitions via SignalWatcher.
//
// Spawn pattern mirrors team-orchestrator.ts (line 202).

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync, createWriteStream } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

import { ScrollbackBuffer } from "./scrollback-buffer.js";
import { SignalWatcher } from "./signal-watcher.js";
import type {
  SessionInfo,
  SessionStatus,
  SessionCreateOptions,
  SessionManagerOptions,
  ChannelEvent,
} from "./types.js";

interface SessionEntry {
  info: SessionInfo;
  process: ChildProcess;
  scrollback: ScrollbackBuffer;
  watcher: SignalWatcher;
  timeoutHandle: ReturnType<typeof setTimeout> | null;
  killHandle: ReturnType<typeof setTimeout> | null;
  stderr: string;
  outputLogStream: ReturnType<typeof createWriteStream> | null;
}

const DEFAULT_MAX_SESSIONS = 20;
const DEFAULT_SCROLLBACK = 2000;
const DEFAULT_TIMEOUT = 600;
const MAX_TIMEOUT = 3600;
const KILL_GRACE_MS = 5000;

export class SessionManager {
  private sessions = new Map<string, SessionEntry>();
  private maxSessions: number;
  private scrollbackCapacity: number;
  private onStateChange?: (sessionId: string, event: ChannelEvent) => void;
  private sigintHandler: (() => void) | null = null;

  constructor(options?: SessionManagerOptions) {
    this.maxSessions = options?.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.scrollbackCapacity = options?.scrollbackCapacity ?? DEFAULT_SCROLLBACK;
    this.onStateChange = options?.onStateChange;
  }

  /** Create and start a new session. Returns the session ID. */
  createSession(opts: SessionCreateOptions): string {
    if (this.activeSessions >= this.maxSessions) {
      throw new Error(`Max sessions (${this.maxSessions}) reached`);
    }

    const sessionId = randomUUID().slice(0, 8);
    const timeout = Math.min(opts.timeoutSeconds ?? DEFAULT_TIMEOUT, MAX_TIMEOUT);
    const startedAt = new Date().toISOString();

    // Create session artifact directory
    const sessionDir = join(homedir(), ".claudish", "sessions", sessionId);
    mkdirSync(sessionDir, { recursive: true });

    // Write initial prompt if provided
    if (opts.prompt) {
      writeFileSync(join(sessionDir, "prompt.md"), opts.prompt, "utf-8");
    }

    // Build spawn args — mirrors team-orchestrator pattern
    const args = ["--model", opts.model, "-y", "--stdin", "--quiet", ...(opts.claudishFlags ?? [])];

    const proc = spawn("claudish", args, {
      cwd: opts.cwd ?? process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });

    const scrollback = new ScrollbackBuffer(this.scrollbackCapacity);
    const watcher = new SignalWatcher(sessionId, (sid, data) => {
      // Update session status from watcher state
      const entry = this.sessions.get(sid);
      if (entry) {
        entry.info.status = data.newState as SessionStatus;
        entry.info.elapsedSeconds = this.getElapsed(entry.info.startedAt);

        // Dispatch channel event
        this.onStateChange?.(sid, {
          type: data.newState,
          model: entry.info.model,
          content: data.content ?? "",
          elapsedSeconds: entry.info.elapsedSeconds,
          createdAt: entry.info.startedAt,
          extraMeta: {
            ...(data.toolName ? { tool: data.toolName } : {}),
            ...(data.toolCount ? { tool_count: String(data.toolCount) } : {}),
          },
        });
      }
    });

    // Create output log stream
    const outputLogStream = createWriteStream(join(sessionDir, "output.log"));

    const entry: SessionEntry = {
      info: {
        sessionId,
        model: opts.model,
        status: "starting",
        pid: proc.pid ?? null,
        startedAt,
        completedAt: null,
        exitCode: null,
        turnsCompleted: 0,
        tokensUsed: 0,
        elapsedSeconds: 0,
      },
      process: proc,
      scrollback,
      watcher,
      timeoutHandle: null,
      killHandle: null,
      stderr: "",
      outputLogStream,
    };

    this.sessions.set(sessionId, entry);

    // Pipe stdout → scrollback + watcher + output.log
    proc.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      scrollback.append(text);
      watcher.feed(text);
      outputLogStream.write(chunk);
    });

    // Collect stderr
    proc.stderr?.on("data", (chunk: Buffer) => {
      entry.stderr += chunk.toString("utf-8");
    });

    // Write prompt to stdin if provided
    if (opts.prompt) {
      proc.stdin?.write(opts.prompt);
      proc.stdin?.end();
    }

    // Handle process exit
    proc.on("exit", (code) => {
      entry.info.exitCode = code;
      entry.info.completedAt = new Date().toISOString();
      entry.info.elapsedSeconds = this.getElapsed(entry.info.startedAt);

      // Clear timeout timers
      if (entry.timeoutHandle) clearTimeout(entry.timeoutHandle);
      if (entry.killHandle) clearTimeout(entry.killHandle);

      // Let watcher handle state transition
      watcher.processExited(code);

      // Close output log
      outputLogStream.end();

      // Write stderr log
      if (entry.stderr) {
        writeFileSync(join(sessionDir, "stderr.log"), entry.stderr, "utf-8");
      }

      // Write meta.json
      writeFileSync(join(sessionDir, "meta.json"), JSON.stringify(entry.info, null, 2), "utf-8");

      this.cleanupSigint();
    });

    proc.on("error", (err) => {
      entry.info.status = "failed";
      entry.info.completedAt = new Date().toISOString();
      watcher.forceState("failed", `Spawn error: ${err.message}`);
    });

    // Set timeout
    entry.timeoutHandle = setTimeout(() => {
      if (!proc.killed) {
        proc.kill("SIGTERM");
        entry.killHandle = setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {
            // Process may already be gone
          }
        }, KILL_GRACE_MS);

        entry.info.status = "timeout";
        entry.info.completedAt = new Date().toISOString();
        watcher.forceState("failed", `Timeout after ${timeout}s`);
      }
    }, timeout * 1000);

    // Register SIGINT handler if first session
    this.setupSigint();

    return sessionId;
  }

  /** Write input to a session's stdin. */
  sendInput(sessionId: string, text: string): boolean {
    const entry = this.sessions.get(sessionId);
    if (!entry) return false;

    // Only allow input if session is in a state that can receive it
    const inputStates: SessionStatus[] = ["starting", "running", "waiting_for_input"];
    if (!inputStates.includes(entry.info.status)) return false;

    try {
      entry.process.stdin?.write(text + "\n");
      return true;
    } catch {
      return false;
    }
  }

  /** Get output from a session's scrollback buffer. */
  getOutput(
    sessionId: string,
    tailLines?: number
  ): {
    sessionId: string;
    status: SessionStatus;
    output: string;
    totalLines: number;
    turnsCompleted: number;
    tokensUsed: number;
    elapsedSeconds: number;
  } {
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new Error(`Session ${sessionId} not found`);

    entry.info.elapsedSeconds = this.getElapsed(entry.info.startedAt);

    const lines = entry.scrollback.getLines(tailLines);
    return {
      sessionId,
      status: entry.info.status,
      output: lines.join("\n"),
      totalLines: entry.scrollback.totalLines,
      turnsCompleted: entry.info.turnsCompleted,
      tokensUsed: entry.info.tokensUsed,
      elapsedSeconds: entry.info.elapsedSeconds,
    };
  }

  /** Cancel a session. */
  cancelSession(sessionId: string): boolean {
    const entry = this.sessions.get(sessionId);
    if (!entry) return false;

    const terminalStates: SessionStatus[] = ["completed", "failed", "cancelled", "timeout"];
    if (terminalStates.includes(entry.info.status)) return false;

    // Clear timeout timers
    if (entry.timeoutHandle) clearTimeout(entry.timeoutHandle);
    if (entry.killHandle) clearTimeout(entry.killHandle);

    entry.info.status = "cancelled";
    entry.info.completedAt = new Date().toISOString();
    entry.watcher.forceState("cancelled", "Session cancelled");

    if (!entry.process.killed) {
      entry.process.kill("SIGTERM");
      entry.killHandle = setTimeout(() => {
        try {
          entry.process.kill("SIGKILL");
        } catch {
          // Process may already be gone
        }
      }, KILL_GRACE_MS);
    }

    return true;
  }

  /** List sessions. */
  listSessions(includeCompleted = false): SessionInfo[] {
    const sessions: SessionInfo[] = [];
    for (const entry of this.sessions.values()) {
      // Update elapsed time for active sessions
      const terminalStates: SessionStatus[] = ["completed", "failed", "cancelled", "timeout"];
      const isTerminal = terminalStates.includes(entry.info.status);

      if (!includeCompleted && isTerminal) continue;

      if (!isTerminal) {
        entry.info.elapsedSeconds = this.getElapsed(entry.info.startedAt);
      }

      sessions.push({ ...entry.info });
    }
    return sessions;
  }

  /** Get a single session's info. */
  getSession(sessionId: string): SessionInfo {
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new Error(`Session ${sessionId} not found`);
    entry.info.elapsedSeconds = this.getElapsed(entry.info.startedAt);
    return { ...entry.info };
  }

  /** Shut down all active sessions. */
  async shutdownAll(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const [id, entry] of this.sessions) {
      if (!entry.process.killed) {
        entry.process.kill("SIGTERM");
        promises.push(
          new Promise((resolve) => {
            const timeout = setTimeout(() => {
              try {
                entry.process.kill("SIGKILL");
              } catch {}
              resolve();
            }, KILL_GRACE_MS);

            entry.process.on("exit", () => {
              clearTimeout(timeout);
              resolve();
            });
          })
        );
      }
    }
    await Promise.all(promises);
    this.cleanupSigint();
  }

  // ─── Internal ────────────────────────────────────────────────────────

  private get activeSessions(): number {
    let count = 0;
    const terminalStates: SessionStatus[] = ["completed", "failed", "cancelled", "timeout"];
    for (const entry of this.sessions.values()) {
      if (!terminalStates.includes(entry.info.status)) count++;
    }
    return count;
  }

  private getElapsed(startedAt: string): number {
    return Math.round((Date.now() - new Date(startedAt).getTime()) / 1000);
  }

  private setupSigint(): void {
    if (this.sigintHandler) return;
    this.sigintHandler = () => {
      this.shutdownAll().catch(() => {});
      process.exit(1);
    };
    process.on("SIGINT", this.sigintHandler);
  }

  private cleanupSigint(): void {
    if (this.activeSessions > 0) return;
    if (this.sigintHandler) {
      process.off("SIGINT", this.sigintHandler);
      this.sigintHandler = null;
    }
  }
}
