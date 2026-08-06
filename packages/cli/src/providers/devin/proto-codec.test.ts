import { describe, expect, test } from "bun:test";
import {
  FRAME_HEADER_BYTES,
  bytes,
  createFrameReader,
  envelope,
  msg,
  parseTLV,
  readFloat32LE,
  readString,
  readVarintValue,
  vint,
} from "./proto-codec.js";

describe("Devin protobuf codec", () => {
  test("varint encoding round-trips boundary values", () => {
    for (const value of [0, 1, 127, 128, 300, 2 ** 40, Number.MAX_SAFE_INTEGER]) {
      const [field] = parseTLV(vint(1, value));
      expect(field).toBeDefined();
      expect(field!.no).toBe(1);
      expect(field!.wire).toBe(0);
      expect(readVarintValue(field!)).toBe(value);
    }
  });

  test("bytes, vint, and msg produce parseable field numbers and wire types", () => {
    const nested = msg(bytes(1, "nested"), vint(2, 300));
    const fields = parseTLV(msg(bytes(4, "hello"), vint(18, 128), bytes(7, nested)));

    expect(fields.map(({ no, wire }) => ({ no, wire }))).toEqual([
      { no: 4, wire: 2 },
      { no: 18, wire: 0 },
      { no: 7, wire: 2 },
    ]);
    expect(readString(fields[0]!)).toBe("hello");
    expect(readVarintValue(fields[1]!)).toBe(128);

    const nestedFields = parseTLV(fields[2]!.payload);
    expect(nestedFields.map(({ no, wire }) => ({ no, wire }))).toEqual([
      { no: 1, wire: 2 },
      { no: 2, wire: 0 },
    ]);
    expect(readString(nestedFields[0]!)).toBe("nested");
    expect(readVarintValue(nestedFields[1]!)).toBe(300);
  });
});

describe("Devin Connect envelope", () => {
  test("writes flags, a big-endian u32 length, and the payload", () => {
    const payload = new Uint8Array(0x0102).fill(0x5a);
    const framed = envelope(payload, 2);

    expect(framed[0]).toBe(2);
    expect(Array.from(framed.subarray(1, FRAME_HEADER_BYTES))).toEqual([0x00, 0x00, 0x01, 0x02]);
    expect(framed.subarray(FRAME_HEADER_BYTES)).toEqual(payload);
  });

  test("reads usage fixed32 values as little-endian float32", () => {
    const floatBytes = new Uint8Array(4);
    new DataView(floatBytes.buffer).setFloat32(0, 42.5, true);
    expect(Array.from(floatBytes)).toEqual([0x00, 0x00, 0x2a, 0x42]);

    const [field] = parseTLV(new Uint8Array([0x0d, ...floatBytes]));
    expect(field).toBeDefined();
    expect(field!.wire).toBe(5);
    // Load-bearing asymmetry: Connect lengths above are BE, but protobuf usage
    // floats are LE. Normalising both to one byte order corrupts one of them.
    expect(readFloat32LE(field!)).toBe(42.5);
  });

  test("frame reading is identical across whole, byte-wise, and split-header chunks", () => {
    const wire = envelope(new TextEncoder().encode("same frame"), 2);

    const wholeReader = createFrameReader();
    const whole = wholeReader(wire);

    const byteReader = createFrameReader();
    const byteWise = [];
    for (const byte of wire) byteWise.push(...byteReader(new Uint8Array([byte])));

    const splitHeaderReader = createFrameReader();
    expect(splitHeaderReader(wire.subarray(0, 3))).toEqual([]);
    const splitInsideLengthPrefix = splitHeaderReader(wire.subarray(3));

    expect(byteWise).toEqual(whole);
    expect(splitInsideLengthPrefix).toEqual(whole);
    expect(whole).toEqual([{ flags: 2, payload: new TextEncoder().encode("same frame") }]);
  });
});
