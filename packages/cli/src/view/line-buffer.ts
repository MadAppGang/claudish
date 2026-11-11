/**
 * JSON Lines framing for a stream read as UTF-8 strings. Each chunk is searched for newlines on
 * its own and the unterminated rest is counted in bytes as it grows, so one long line costs time
 * linear in its length: searching the whole buffer on every chunk is quadratic, and a 16 MB line
 * then takes seconds on a slow machine.
 */
export interface LinePush {
  /** the lines this chunk completed, without their newlines */
  lines: string[];
  /** the unterminated rest passed the cap; it was dropped and the buffer is empty again */
  overflow: boolean;
}

export class LineBuffer {
  private rest = "";
  private restBytes = 0;

  constructor(private readonly maxBytes: number) {}

  push(chunk: string): LinePush {
    const lines: string[] = [];
    let start = 0;
    for (let nl = chunk.indexOf("\n"); nl >= 0; nl = chunk.indexOf("\n", start)) {
      lines.push(this.rest + chunk.slice(start, nl));
      this.rest = "";
      this.restBytes = 0;
      start = nl + 1;
    }
    const tail = start === 0 ? chunk : chunk.slice(start);
    this.rest += tail;
    this.restBytes += Buffer.byteLength(tail);
    if (this.restBytes <= this.maxBytes) return { lines, overflow: false };
    this.reset();
    return { lines, overflow: true };
  }

  reset(): void {
    this.rest = "";
    this.restBytes = 0;
  }
}
