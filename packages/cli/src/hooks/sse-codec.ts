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

const SEPARATORS = ["\r\n\r\n", "\n\n"] as const;

/** Index and length of the earliest event terminator in `text`, or null. */
function findTerminator(text: string): { at: number; length: number } | null {
  let best: { at: number; length: number } | null = null;
  for (const sep of SEPARATORS) {
    const at = text.indexOf(sep);
    if (at !== -1 && (best === null || at < best.at)) best = { at, length: sep.length };
  }
  return best;
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
      events.push({ raw, ...parseSseFields(raw), complete: false });
    }
    return events;
  }

  /** Bytes of decoded text held while waiting for a terminator (UTF-16 units). */
  get pending(): number {
    return this.buffer.length;
  }

  private drain(): SseEvent[] {
    const events: SseEvent[] = [];
    for (;;) {
      const term = findTerminator(this.buffer);
      if (!term) break;
      const raw = this.buffer.slice(0, term.at + term.length);
      this.buffer = this.buffer.slice(term.at + term.length);
      events.push({ raw, ...parseSseFields(raw), complete: true });
    }
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
