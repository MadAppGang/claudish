/**
 * Claude-SSE codec for the response seam.
 *
 * A streaming splitter that turns network chunks into whole SSE events, and the
 * serialisers the seam uses to re-emit them. Three properties carry the seam's
 * safety rules:
 *
 * - **UTF-8 safe.** Bytes pass through ONE `TextDecoder("utf-8")` in stream
 *   mode, so a multi-byte character split across two network chunks is decoded
 *   whole, and text actions operate on JS strings that never hold half of one.
 * - **Raw-preserving.** Every event keeps its exact decoded text, terminator
 *   included, so an event forwarded unchanged is re-encoded byte-identically
 *   (for valid UTF-8).
 * - **Never drops.** An unparseable event is still an event (`raw` is kept and
 *   `data` may be null); at end of stream an unterminated remainder is returned
 *   as an incomplete event to forward raw.
 */

/** One SSE event as it arrived. */
export interface SseEvent {
  /** The exact decoded text, including its blank-line terminator when complete. */
  raw: string;
  /** The `event:` field, or null. */
  event: string | null;
  /** The `data:` lines joined with "\n", or null when there were none. */
  data: string | null;
  /** False only for an unterminated remainder flushed at end of stream. */
  complete: boolean;
}

/** Parse the fields of one event's text (terminator optional). */
export function parseSseFields(raw: string): { event: string | null; data: string | null } {
  let event: string | null = null;
  const data: string[] = [];
  for (const line of raw.split(/\r\n|\n|\r/)) {
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  return { event, data: data.length > 0 ? data.join("\n") : null };
}

/** Streaming splitter. One instance per response body. */
export class SseSplitter {
  private readonly decoder = new TextDecoder("utf-8");
  private buffer = "";
  /** where the next `\n` search resumes: the buffer before it holds no terminator */
  private scanFrom = 0;

  /** Feed one network chunk; returns every event it completed, in order. */
  push(chunk: Uint8Array | string): SseEvent[] {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    return this.drain();
  }

  /** End of stream: flush the decoder and return any remainder as an incomplete event. */
  end(): SseEvent[] {
    this.buffer += this.decoder.decode();
    const events = this.drain();
    if (this.buffer.length > 0) {
      const raw = this.buffer;
      this.buffer = "";
      this.scanFrom = 0;
      events.push({ raw, ...parseSseFields(raw), complete: false });
    }
    return events;
  }

  /** Bytes of decoded text held while waiting for a terminator (UTF-16 units). */
  get pending(): number {
    return this.buffer.length;
  }

  /**
   * Cut every complete event off the buffer, in ONE pass over the text added since the
   * last call, and slice the buffer once. A terminator is the earliest `\n\n`
   * or `\r\n\r\n`; both contain a `\n` followed by `\n` or `\r\n`, so only `\n`
   * positions are visited. A `\n` too close to the end to decide is resumed from on
   * the next push. Searching both separators over the whole remainder once per event
   * was quadratic in the size of one chunk: 5.5 s for 8 MB of deltas.
   */
  private drain(): SseEvent[] {
    const events: SseEvent[] = [];
    const buf = this.buffer;
    let start = 0;
    let resume = -1;
    let i = buf.indexOf("\n", this.scanFrom);
    while (i !== -1) {
      const next = buf[i + 1];
      if (next === undefined) {
        resume = i;
        break;
      }
      let at = -1;
      let length = 0;
      if (next === "\n") {
        at = i;
        length = 2;
      } else if (next === "\r" && i - 1 >= start && buf[i - 1] === "\r") {
        const after = buf[i + 2];
        if (after === undefined) {
          resume = i;
          break;
        }
        if (after === "\n") {
          at = i - 1;
          length = 4;
        }
      }
      if (at === -1) {
        i = buf.indexOf("\n", i + 1);
        continue;
      }
      const raw = buf.slice(start, at + length);
      events.push({ raw, ...parseSseFields(raw), complete: true });
      start = at + length;
      i = buf.indexOf("\n", start);
    }
    this.buffer = start === 0 ? buf : buf.slice(start);
    this.scanFrom = resume === -1 ? this.buffer.length : resume - start;
    return events;
  }
}

/** The event's `data` parsed as JSON, or undefined when absent or unparseable. */
export function eventJson(event: Pick<SseEvent, "data">): unknown {
  if (event.data === null) return undefined;
  try {
    return JSON.parse(event.data);
  } catch {
    return undefined;
  }
}

/** Serialise one event: `event:` line (when named), one `data:` line per data line, blank line. */
export function serializeSseEvent(event: string | null, data: string | object): string {
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  const lines = event ? [`event: ${event}`] : [];
  for (const line of payload.split("\n")) lines.push(`data: ${line}`);
  return `${lines.join("\n")}\n\n`;
}

const encoder = new TextEncoder();

/** Encode text for the wire. */
export function encodeUtf8(text: string): Uint8Array {
  return encoder.encode(text);
}

/**
 * Split text into pieces of at most `max` UTF-16 code units, never between the
 * two halves of a surrogate pair. Used to re-emit a rewritten text block as
 * `text_delta` events of bounded size.
 */
export function chunkText(text: string, max = 1024): string[] {
  if (max < 2) throw new RangeError("chunkText max must be at least 2");
  const pieces: string[] = [];
  let at = 0;
  while (at < text.length) {
    let end = Math.min(at + max, text.length);
    if (end < text.length) {
      const last = text.charCodeAt(end - 1);
      // A high surrogate at the cut would be separated from its low half.
      if (last >= 0xd800 && last <= 0xdbff) end--;
    }
    pieces.push(text.slice(at, end));
    at = end;
  }
  return pieces;
}
