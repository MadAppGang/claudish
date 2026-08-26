/**
 * TranscriptTailer — incremental, poll-based JSONL file tailer.
 *
 * Mirrors the repo's established patterns: setTimeout+stat poll loop, and
 * ollama-jsonl.ts's buffer split/pop incremental line parsing. No held file
 * descriptors between ticks (open/read/close per delta), no fs.watch.
 *
 * Failure posture: an fs error stops the tailer (dead, via onError) — it
 * never throws into the caller. `syncNow()` runs one immediate synchronous
 * tick so request-time reads are deterministic.
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";

export interface TranscriptTailerOptions {
  /** Poll interval in ms (default 250). */
  pollIntervalMs?: number;
  /** Called once when an fs error kills the tailer. */
  onError?: (err: unknown) => void;
}

const DEFAULT_POLL_INTERVAL_MS = 250;

export class TranscriptTailer {
  private offset = 0;
  private buffer = "";
  private decoder = new TextDecoder();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(
    private filePath: string,
    private onLine: (line: string) => void,
    private opts: TranscriptTailerOptions = {}
  ) {}

  /** Backfill from byte 0 (late attach reconstructs full state), then poll. */
  start(): void {
    if (this.disposed) return;
    this.tick();
    this.schedule();
  }

  /** One immediate synchronous tick — request-time drain. */
  syncNow(): void {
    this.tick();
  }

  /** Stop polling. Idempotent. */
  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(): void {
    if (this.disposed) return;
    this.timer = setTimeout(() => {
      this.tick();
      this.schedule();
    }, this.opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    // A live poll timer must never keep the process alive.
    this.timer.unref?.();
  }

  private tick(): void {
    if (this.disposed) return;
    try {
      const size = statSync(this.filePath).size;
      if (size < this.offset) {
        // Truncation — reset and re-backfill from byte 0.
        this.offset = 0;
        this.buffer = "";
        this.decoder = new TextDecoder();
      }
      if (size === this.offset) return;

      const fd = openSync(this.filePath, "r");
      let chunk: Buffer;
      try {
        chunk = Buffer.alloc(size - this.offset);
        const bytesRead = readSync(fd, chunk, 0, chunk.length, this.offset);
        this.offset += bytesRead;
        if (bytesRead < chunk.length) chunk = chunk.subarray(0, bytesRead);
      } finally {
        closeSync(fd);
      }

      // stream:true keeps a multi-byte UTF-8 sequence split across ticks intact.
      this.buffer += this.decoder.decode(chunk, { stream: true });
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) this.onLine(line);
      }
    } catch (err) {
      // Dead tailer, never a crash — the registry's lazy re-ensure can rebuild.
      this.dispose();
      this.opts.onError?.(err);
    }
  }
}
