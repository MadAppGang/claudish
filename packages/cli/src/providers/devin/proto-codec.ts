/**
 * Pure protobuf + Connect codec for the Devin (Cognition/Codeium) transport.
 *
 * Deliberately tiny: the Devin schema uses only varints and length-delimited
 * fields, so this needs no codegen, no `.proto`, and no runtime dependency —
 * `node:` builtins only. It is also strictly PURE: no I/O, no logging, no
 * module-level side effects, so it can be exercised offline byte-for-byte.
 *
 * Lifted from the live-verified prototype
 * (`ai-docs/sessions/dev-feature-devin-provider-.../prototype/{encode,tlv,decode}.ts`),
 * which streamed text, reasoning, and tool calls from three model families.
 * Do not redesign it — it is a transcription of a working wire format.
 *
 * ## protobuf wire format
 *
 * ```
 * tag = (fieldNumber << 3) | wireType
 * wire 0 = varint · 1 = fixed64 · 2 = length-delimited · 5 = fixed32
 * ```
 *
 * ## Connect envelope
 *
 * ```
 * [flags: u8][length: u32 BIG-endian][payload]
 * flags 0 = message · flags 2 = end-of-stream (JSON body; `{}` on success)
 * ```
 *
 * Only the STREAMING rpc (`GetChatMessage`, `application/connect+proto`) is
 * enveloped. The unary metadata rpcs (`GetCliModelConfigs`,
 * `GetCliTeamSettings`, `application/proto`) send and receive a BARE message —
 * see `devin-models.ts`.
 *
 * Errors arrive INSIDE an HTTP 200, as a `flags=2` frame carrying
 * `{"error":{"code":…,"message":…}}`. The HTTP status alone never signals
 * failure on this backend.
 */

/** Bytes in a Connect envelope header: 1 flag byte + a u32 big-endian length. */
export const FRAME_HEADER_BYTES = 5;

/** Envelope flag marking the end-of-stream frame (its payload is JSON). */
export const FRAME_FLAG_END_OF_STREAM = 2;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// ---------------------------------------------------------------------------
// Encode
// ---------------------------------------------------------------------------

/**
 * Concatenate byte runs into one buffer.
 *
 * The `Uint8Array<ArrayBuffer>` return is load-bearing, not decoration: encoded
 * bytes are handed straight to `fetch` as a body, and `BodyInit` rejects the
 * default `Uint8Array<ArrayBufferLike>` (it could be `SharedArrayBuffer`-backed).
 * Every encoder here allocates a fresh buffer, so the narrower type is honest.
 */
function cat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Base-128 varint. Goes through BigInt so values above 2^32 (context windows,
 * timestamps) encode exactly rather than through a lossy 32-bit shift.
 */
export function varint(n: number | bigint): Uint8Array<ArrayBuffer> {
  let value = BigInt(n);
  const out: number[] = [];
  do {
    let byte = Number(value & 0x7fn);
    value >>= 7n;
    if (value > 0n) byte |= 0x80;
    out.push(byte);
  } while (value > 0n);
  return new Uint8Array(out);
}

/** Field tag: `(fieldNumber << 3) | wireType`. */
function tag(fieldNumber: number, wireType: number): Uint8Array {
  return varint((fieldNumber << 3) | wireType);
}

/** Length-delimited field (wire type 2): a string, nested message, or blob. */
export function bytes(fieldNumber: number, value: Uint8Array | string): Uint8Array<ArrayBuffer> {
  const body = typeof value === "string" ? textEncoder.encode(value) : value;
  return cat([tag(fieldNumber, 2), varint(body.length), body]);
}

/** Varint field (wire type 0): an integer or enum. */
export function vint(fieldNumber: number, value: number | bigint): Uint8Array<ArrayBuffer> {
  return cat([tag(fieldNumber, 0), varint(value)]);
}

/**
 * Concatenate encoded fields into a message body. Protobuf messages are just
 * their fields laid end to end, so this is `cat` under a name that reads
 * correctly at the call sites: `bytes(1, msg(bytes(1, "chisel"), …))`.
 */
export function msg(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  return cat(parts);
}

/** Write a u32 big-endian at `offset` (no DataView byteOffset foot-gun). */
function writeUint32BE(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

/** Read a u32 big-endian at `offset`. */
function readUint32BE(source: Uint8Array, offset: number): number {
  return (
    ((source[offset]! << 24) |
      (source[offset + 1]! << 16) |
      (source[offset + 2]! << 8) |
      source[offset + 3]!) >>>
    0
  );
}

/** Wrap a payload in a Connect envelope. `flags = 2` marks end-of-stream. */
export function envelope(payload: Uint8Array, flags = 0): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(FRAME_HEADER_BYTES + payload.length);
  out[0] = flags;
  writeUint32BE(out, 1, payload.length);
  out.set(payload, FRAME_HEADER_BYTES);
  return out;
}

// ---------------------------------------------------------------------------
// Decode
// ---------------------------------------------------------------------------

/**
 * One decoded protobuf field, byte-preserving.
 *
 * `raw` spans the tag through the end of the value (useful for re-emitting a
 * field untouched); `payload` is the value alone — the varint bytes for wire 0,
 * the 4/8 fixed bytes for wire 5/1, and the delimited body for wire 2.
 */
export interface TLV {
  no: number;
  wire: number;
  raw: Uint8Array;
  payload: Uint8Array;
}

/** Read a varint starting at `p`; returns the value and the next offset. */
function readVarintAt(buf: Uint8Array, p: number): [bigint, number] {
  let value = 0n;
  let shift = 0n;
  let offset = p;
  while (offset < buf.length) {
    const byte = buf[offset++]!;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7n;
  }
  return [value, offset];
}

/**
 * Split a message body into its fields without a schema.
 *
 * Stops (rather than throwing) on a zero field number, an unknown wire type, or
 * a truncated buffer — a decoder for a reverse-engineered schema must degrade,
 * never crash a live turn. Sub-messages are decoded by calling `parseTLV` again
 * on a field's `payload`.
 */
export function parseTLV(buf: Uint8Array): TLV[] {
  const out: TLV[] = [];
  let p = 0;
  while (p < buf.length) {
    const start = p;
    let rawTag: bigint;
    [rawTag, p] = readVarintAt(buf, p);
    const no = Number(rawTag >> 3n);
    const wire = Number(rawTag & 7n);
    if (no === 0) break;

    let payloadStart = p;
    if (wire === 0) {
      [, p] = readVarintAt(buf, p);
    } else if (wire === 1) {
      p += 8;
    } else if (wire === 5) {
      p += 4;
    } else if (wire === 2) {
      let len: bigint;
      [len, p] = readVarintAt(buf, p);
      payloadStart = p;
      p += Number(len);
    } else {
      break;
    }
    if (p > buf.length) break;

    out.push({ no, wire, raw: buf.subarray(start, p), payload: buf.subarray(payloadStart, p) });
  }
  return out;
}

/** Decode a wire-type-0 field's value. Returns 0 for any other wire type. */
export function readVarintValue(tlv: TLV): number {
  if (tlv.wire !== 0) return 0;
  const [value] = readVarintAt(tlv.payload, 0);
  return Number(value);
}

/**
 * Decode a wire-type-5 (fixed32) field as an IEEE-754 LITTLE-endian float.
 *
 * This is how the backend reports token counts (usage group `28 → 2 → 4 → 2`),
 * so callers round the result. A short/absent payload reads as 0 rather than
 * NaN — an absent usage value means zero, not "unknown".
 */
export function readFloat32LE(tlv: TLV): number {
  if (tlv.wire !== 5 || tlv.payload.length < 4) return 0;
  const view = new DataView(tlv.payload.buffer, tlv.payload.byteOffset, tlv.payload.byteLength);
  return view.getFloat32(0, true);
}

/**
 * Decode a length-delimited field's payload as UTF-8.
 *
 * Safe for whole fields only: a protobuf field is complete before it is parsed,
 * so no multi-byte sequence is ever split here. Incremental TEXT assembly
 * across stream frames is the stream parser's job, not this function's.
 */
export function readString(tlv: TLV): string {
  return textDecoder.decode(tlv.payload);
}

// ---------------------------------------------------------------------------
// Connect frame reader (incremental)
// ---------------------------------------------------------------------------

/** One Connect envelope frame. */
export interface ConnectFrame {
  /** Envelope flag byte: 0 = message, 2 = end-of-stream (JSON payload). */
  flags: number;
  /** Frame body, exclusive of the 5-byte header. */
  payload: Uint8Array;
}

/**
 * Build an incremental Connect envelope splitter.
 *
 * Push network chunks in, get COMPLETE frames out. A frame routinely spans
 * chunk boundaries (including a boundary inside the 5-byte header) and a single
 * chunk routinely holds several frames, so buffering the whole body instead
 * would be the only alternative — and that destroys streaming, which is the
 * point of the transport. The prototype proved the incremental path live
 * (88 frames, ttft 2.5s).
 *
 * Each reader owns its own partial buffer, so one reader belongs to exactly one
 * response. Payloads are copied out of the working buffer so a completed frame
 * never keeps the (growing) accumulator alive.
 */
export function createFrameReader(): (chunk: Uint8Array) => ConnectFrame[] {
  let pending: Uint8Array = new Uint8Array(0);

  return (chunk: Uint8Array): ConnectFrame[] => {
    if (chunk.length > 0) {
      if (pending.length === 0) {
        pending = chunk;
      } else {
        const merged = new Uint8Array(pending.length + chunk.length);
        merged.set(pending, 0);
        merged.set(chunk, pending.length);
        pending = merged;
      }
    }

    const frames: ConnectFrame[] = [];
    let offset = 0;
    while (offset + FRAME_HEADER_BYTES <= pending.length) {
      const flags = pending[offset]!;
      const length = readUint32BE(pending, offset + 1);
      const end = offset + FRAME_HEADER_BYTES + length;
      if (end > pending.length) break; // frame still in flight
      frames.push({ flags, payload: pending.slice(offset + FRAME_HEADER_BYTES, end) });
      offset = end;
    }

    if (offset > 0) pending = pending.slice(offset);
    return frames;
  };
}
