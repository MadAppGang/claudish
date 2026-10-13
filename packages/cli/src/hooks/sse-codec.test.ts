import { describe, expect, it } from "bun:test";
import {
  SseSplitter,
  chunkText,
  encodeUtf8,
  eventJson,
  parseSseFields,
  serializeSseEvent,
} from "./sse-codec.js";

const bytes = (s: string) => new TextEncoder().encode(s);

describe("SseSplitter", () => {
  it("splits complete events and keeps each raw text with its terminator", () => {
    const s = new SseSplitter();
    const events = s.push(
      bytes('event: ping\ndata: {"type":"ping"}\n\nevent: message_stop\ndata: {}\n\n')
    );
    expect(events.map((e) => e.event)).toEqual(["ping", "message_stop"]);
    expect(events[0]?.raw).toBe('event: ping\ndata: {"type":"ping"}\n\n');
    expect(eventJson(events[0] as { data: string | null })).toEqual({ type: "ping" });
    expect(events.every((e) => e.complete)).toBe(true);
  });

  it("holds a partial event until its terminator arrives", () => {
    const s = new SseSplitter();
    expect(s.push(bytes('event: content_block_delta\ndata: {"a"'))).toEqual([]);
    expect(s.pending).toBeGreaterThan(0);
    expect(s.push(bytes(":1}\n"))).toEqual([]);
    const events = s.push(bytes("\nevent: ping\n"));
    expect(events.map((e) => e.data)).toEqual(['{"a":1}']);
    expect(s.end().map((e) => [e.raw, e.complete])).toEqual([["event: ping\n", false]]);
  });

  it("decodes a multi-byte character split across chunks", () => {
    const whole = bytes('data: {"text":"héllo 😀"}\n\n');
    // Cut inside the 4-byte emoji and inside the 2-byte é.
    const emojiAt = whole.indexOf(0xf0);
    const eAt = whole.indexOf(0xc3);
    const s = new SseSplitter();
    const out = [
      ...s.push(whole.slice(0, eAt + 1)),
      ...s.push(whole.slice(eAt + 1, emojiAt + 2)),
      ...s.push(whole.slice(emojiAt + 2)),
    ];
    expect(out.length).toBe(1);
    expect(eventJson(out[0] as { data: string | null })).toEqual({ text: "héllo 😀" });
    // Raw-preserving: re-encoding reproduces the input bytes exactly.
    expect(Buffer.from(encodeUtf8(out[0]?.raw ?? "")).equals(Buffer.from(whole))).toBe(true);
  });

  it("splits on CRLF terminators too", () => {
    const s = new SseSplitter();
    const events = s.push(bytes("event: a\r\ndata: 1\r\n\r\nevent: b\r\ndata: 2\r\n\r\n"));
    expect(events.map((e) => [e.event, e.data])).toEqual([
      ["a", "1"],
      ["b", "2"],
    ]);
  });

  it("keeps an unparseable event rather than dropping it", () => {
    const s = new SseSplitter();
    const events = s.push(bytes("garbage line\n\n"));
    expect(events.length).toBe(1);
    expect(events[0]?.raw).toBe("garbage line\n\n");
    expect(eventJson(events[0] as { data: string | null })).toBeUndefined();
  });

  it("flushes an unterminated remainder at end of stream", () => {
    const s = new SseSplitter();
    s.push(bytes("data: tail"));
    expect(s.end()).toEqual([{ raw: "data: tail", event: null, data: "tail", complete: false }]);
    expect(s.end()).toEqual([]);
  });
});

describe("parseSseFields", () => {
  it("joins data lines, strips one leading space, ignores comments", () => {
    expect(parseSseFields(": comment\nevent:x\ndata: a\ndata:  b\n\n")).toEqual({
      event: "x",
      data: "a\n b",
    });
  });
});

describe("serializeSseEvent", () => {
  it("round-trips through the splitter", () => {
    const wire = serializeSseEvent("content_block_delta", {
      type: "content_block_delta",
      index: 2,
      delta: { type: "text_delta", text: "a\nb" },
    });
    expect(wire.endsWith("\n\n")).toBe(true);
    const [event] = new SseSplitter().push(wire);
    expect(event?.event).toBe("content_block_delta");
    expect(eventJson(event as { data: string | null })).toEqual({
      type: "content_block_delta",
      index: 2,
      delta: { type: "text_delta", text: "a\nb" },
    });
  });

  it("omits the event line for an unnamed event and splits multi-line data", () => {
    expect(serializeSseEvent(null, "a\nb")).toBe("data: a\ndata: b\n\n");
  });
});

describe("chunkText", () => {
  it("cuts at the limit without splitting a surrogate pair", () => {
    const text = `${"a".repeat(1023)}😀tail`;
    const pieces = chunkText(text, 1024);
    expect(pieces[0]).toBe("a".repeat(1023));
    expect(pieces.join("")).toBe(text);
    for (const p of pieces) expect(p.length).toBeLessThanOrEqual(1024);
    for (const p of pieces) expect(() => encodeURIComponent(p)).not.toThrow();
  });

  it("returns nothing for empty text and one piece for short text", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("short")).toEqual(["short"]);
  });
});
