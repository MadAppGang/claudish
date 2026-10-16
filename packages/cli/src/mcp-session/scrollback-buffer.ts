// ─── ScrollbackBuffer ────────────────────────────────────────────────────────
//
// In-memory ring buffer for PTY output. Each session gets one.
// Default: 2000 lines (~200KB). 10 concurrent sessions ≈ 2MB.

// Strip ANSI escape sequences (colors, cursor movement, etc.)
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences require control chars
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?\x07|\x1b[()][AB012]|\x1b[>=<]|\x0f|\x0e/g;

export class ScrollbackBuffer {
  private lines: string[];
  private head: number;
  private count: number;
  private _totalLines: number;
  private readonly capacity: number;

  constructor(capacity = 2000) {
    this.capacity = capacity;
    this.lines = new Array(capacity);
    this.head = 0;
    this.count = 0;
    this._totalLines = 0;
  }

  /** Append raw text. Splits on newlines, strips ANSI codes. */
  append(data: string): void {
    const cleaned = data.replace(ANSI_RE, "");
    const newLines = cleaned.split("\n");

    for (let i = 0; i < newLines.length; i++) {
      // Skip empty trailing element from split (trailing newline)
      if (newLines[i] === "" && i === newLines.length - 1) continue;

      this.lines[this.head] = newLines[i];
      this.head = (this.head + 1) % this.capacity;
      if (this.count < this.capacity) this.count++;
      this._totalLines++;
    }
  }

  /** Get last N lines (default: all stored lines). */
  getLines(n?: number): string[] {
    const count = n !== undefined ? Math.min(n, this.count) : this.count;
    if (count === 0) return [];

    const result: string[] = new Array(count);
    // Start reading from (head - count) in circular fashion
    let readPos = (this.head - count + this.capacity) % this.capacity;
    for (let i = 0; i < count; i++) {
      result[i] = this.lines[readPos];
      readPos = (readPos + 1) % this.capacity;
    }
    return result;
  }

  /** Total lines ever written (not just currently in buffer). */
  get totalLines(): number {
    return this._totalLines;
  }

  /** Number of lines currently stored. */
  get size(): number {
    return this.count;
  }

  /** Clear all stored lines. */
  clear(): void {
    this.head = 0;
    this.count = 0;
    this._totalLines = 0;
  }
}
